---
title: "Android System Properties End-to-End: From init to Shared Memory and SELinux"
lang: en
translationKey: android-system-properties-init-architecture
slug: android-system-properties-init-architecture
excerpt: "How Android's system property mechanism works: property files, the init property service, zero-copy shared memory reads, SELinux enforcement, and cross-process change notifications."
publishDate: '2026-06-18'
tags:
- "Android"
- "SystemProperties"
- "Performance"
- "Internals"
- "Architecture"
seo:
  title: "Android SystemProperties Internals: init, Shared Memory, SELinux"
  description: "Android system properties: storage layout, init property service, shared memory reads, SELinux enforcement, and change notifications."
  pageType: article
---

Anyone doing Android system development interacts with `adb shell getprop` almost daily. But why can `SystemProperties.get("ro.build.version.sdk")` be called from any process? Where are properties actually stored? How is cross-process synchronization implemented? At which layer does SELinux enforce access control? Answering these questions without reading the source is nearly impossible.

I traced the entire chain while debugging a property that wouldn't stick, and found the design far more elegant than expected.

## Physical Storage of Property Files

Android system properties aren't stored in a database — they're plain text files spread across partitions:

```
/system/build.prop          # core system properties, mostly ro. prefix
/vendor/build.prop          # hardware-related properties
/product/build.prop         # product-specific properties
/system/etc/prop.default    # default properties (Android 10+)
```

The format is minimal — `key=value` text, one per line:

```
ro.build.version.sdk=34
ro.product.brand=google
persist.sys.timezone=Asia/Shanghai
```

At boot, the init process reads these files in order; later-loaded files override earlier ones for the same key. The `ro.` prefix is an exception — init's property service hardcodes it as read-only. Once set, it can't be changed. This constraint isn't enforced by filesystem permissions, so even if a later file contains the same `ro.` property, it's silently ignored.

Properties with the `persist.*` prefix are persisted to `/data/property/`, each property in its own file named after the property key. On reboot, init reloads them so configuration survives. Finding a pile of files named after properties in `/data/property/` is normal behavior, not a problem.

## The init Property Service

At the core of the property system is a property service running in the init process, listening on a Unix Domain Socket:

```c
// system/core/init/property_service.cpp
static constexpr const char kPropertyServiceSocket[] = "/dev/socket/property_service";
```

The startup sequence lives in init's `main()`:

```c
// inside start_property_service()
void start_property_service() {
    // 1. Create the shared memory area
    property_area = __system_property_area_init();

    // 2. Load all property files
    load_properties_from_file("/system/etc/prop.default", nullptr);
    load_properties_from_file("/system/build.prop", nullptr);
    load_properties_from_file("/vendor/build.prop", nullptr);
    // ...

    // 3. Listen on socket for set requests from other processes
    listen(kPropertyServiceSocket, 8);
}
```

Any process wanting to set a system property sends a request through this socket to init. Only init has write access; all other processes can only read. This single-writer, many-reader architecture naturally eliminates concurrent write contention.

## Shared Memory: Zero-Copy Cross-Process Reads

If every `getprop` had to round-trip through a socket to init, the overhead would be unacceptable. Android's solution is shared memory.

During property service startup, init calls `__system_property_area_init()` to create a shared memory region mapped into its own address space. Other processes map the same physical memory through `__system_property_area__`, with the kernel guaranteeing all processes see identical data.

The shared memory structure, simplified:

```c
struct prop_area {
    unsigned volatile count;     // current property count
    unsigned volatile serial;    // magic value for detecting layout changes
    prop_info info[0];           // variable-length array, one entry per property
};

struct prop_info {
    unsigned serial;             // number of times this property was modified
    char name[PROP_NAME_MAX];    // property name
    char value[PROP_VALUE_MAX];  // property value
};
```

When reading a property, libc provides `__system_property_find()` which traverses this shared memory directly — no IPC call needed. Both `adb shell getprop` and `SystemProperties.get()` funnel into the same function:

```c
const prop_info* __system_property_find(const char* name) {
    // traverse the info array in prop_area directly
    // lock-free read, using the serial field for optimistic locking
    for (unsigned i = 0; i < area->count; i++) {
        if (!strcmp(area->info[i].name, name)) {
            return &area->info[i];
        }
    }
    return nullptr;
}
```

The write path is entirely different: the calling process sends a `PROP_MSG_SETPROP` message to init via socket. Init validates, writes to shared memory, and updates the `serial` field. Other processes detect the update on their next read through the changed `serial`.

## SELinux Enforcement

Not just anyone can set properties. Android uses SELinux for fine-grained property access control. The core file is `property_contexts`:

```
# system/sepolicy/private/property_contexts
ro.build.version.sdk      u:object_r:build_prop:s0
persist.sys.timezone       u:object_r:timezone_prop:s0
ctl.start                  u:object_r:ctl_start_prop:s0
```

Each property maps to an SELinux security context. When a process attempts to set a property, init checks whether the process's SELinux domain has `set` permission for the property's context:

```c
// system/core/init/property_service.cpp
static bool check_mac_perms(const std::string& name,
                            char* source_ctx) {
    // query AVC (Access Vector Cache) via selinux_check_access()
    bool has_access = (selinux_check_access(
        source_ctx,         // requesting process's context
        property_context,   // property's context
        "property_service",
        "set",              // operation type
        nullptr) == 0);
    return has_access;
}
```

Mismatches are rejected outright, and the kernel log records an `avc: denied` entry. I hit this once: a native service I wrote tried to set `persist.vendor.xxx` and kept failing. After hours of investigation, I discovered `property_contexts` didn't declare a context for this property, and the fallback rule denied `set` for non-system processes.

**Note**: `ro.`-prefixed properties are rejected by init before SELinux checks even run — even with SELinux permission, you can't modify them. These are two independent layers of defense.

## Cross-Process Notification

When a property changes, how do dependents find out? After writing a property, init sends a `PROP_MSG_CHANGED` message to all processes that registered a listener.

On the Java side, the entry point is `SystemProperties.addChangeCallback()`, which registers a `PropertyChangeListener` at the native layer. The native layer spawns a listener thread that blocks on the socket, waiting for init to push change notifications.

Two details about this mechanism:

1. **Notifications are batched.** Multiple rapid changes to the same property may be coalesced into a single notification, avoiding excessive wakeups.
2. **Notifications don't carry the new value.** After receiving `PROP_MSG_CHANGED`, the process reads the latest value from shared memory itself. This keeps notification messages compact regardless of property value size, and guarantees that even if the property changes again while you're handling the notification, you always read the most recent value.

## Practical Takeaways

After tracing the full chain, several points are worth keeping in mind during daily development:

**Don't abuse `SystemProperties.set()`.** Each set call is an IPC round-trip through SELinux validation, socket transmission, shared memory write, serial update, and notification broadcast. For high-frequency read/write scenarios, use an in-memory cache and sync only at key moments.

**Use `persist.*` properties sparingly.** Every modification triggers a file write under `/data/property/`. Frequent changes incur real disk I/O. For runtime-only state, use a regular property and reinitialize on boot.

**When debugging property issues, run the triple check**: `getprop | grep xxx` for the current value, `dmesg | grep avc` for SELinux denials, `ls -la /data/property/` for persisted files. Most problems surface within these three steps.
