---
title: 'Android SELinux Access Control Architecture: sepolicy Compilation, Domain Transitions, and neverallow Auditing'
lang: en
translationKey: android-selinux-sepolicy-neverallow
slug: android-selinux-sepolicy-neverallow
excerpt: Starting from an avc denial log, this article systematically walks through Android SELinux's sepolicy compilation pipeline, domain transitions, contexts mapping, and neverallow auditing, with native service troubleshooting and practical advice.
publishDate: '2026-08-18'
tags:
- Android
- SELinux
- sepolicy
- Security
- System Architecture
- neverallow
seo:
  title: 'Android SELinux Access Control: sepolicy Compilation to neverallow Audit'
  description: 'A complete guide to Android SELinux access control: sepolicy compilation, domain transitions, contexts mapping, neverallow auditing, and AVC troubleshooting.'
  pageType: article
---

While porting to a new platform, I added a native service to the system, and the process crashed right after it started. logcat showed only one line:

```text
avc: denied { read } for name="vendor_config.json"
scontext=u:r:my_service:s0
tcontext=u:object_r:vendor_configs_file:s0
tclass=file permissive=0
```

This avc log is an SELinux access-denial record, and it is the most common troubleshooting entry point in Android system-level access control. To resolve it, you have to connect the sepolicy compilation pipeline, domain transitions, and neverallow auditing together.

## What SELinux Governs in Android

Android's permission model has two layers: Discretionary Access Control (DAC) and Mandatory Access Control (MAC). DAC is traditional Unix permission: processes read and write files based on their UID, and permissions are decided by the file owner. MAC is provided by SELinux, with system-wide policy uniformly constraining the rules; even if a process gains root, it cannot break out of the range the policy allows.

Android introduced SELinux in 4.3 and has run in full enforcing mode since 5.0. The system assigns a security context to every process, file, property, and binder service, in the unified format `user:role:type:level`, where type is the core of access control.

A mapping of contexts:

```text
u:r:system_server:s0          # system_server 进程域
u:object_r:system_file:s0      # /system 下文件的类型
u:object_r:vendor_file:s0      # /vendor 下文件的类型
```

SELinux policy does not directly state "who is allowed to read what"; instead it states "which domain has which permissions on which classes of which type." Here system_server is the domain, system_file is the type, class is file, and the permission is read.

## The sepolicy Compilation Pipeline

Android's policy source lives in `system/sepolicy`, and both the platform and vendors can extend it independently. A `.te` file looks like this:

```te
type my_service, domain;
type my_service_exec, exec_type, file_type, vendor_file_type;

init_daemon_domain(my_service)

allow my_service vendor_configs_file:file { read getattr open };
```

A `.te` file cannot be deployed directly; it must go through macro expansion, CIL generation, compilation into a binary policy, and then packaging into a partition. The build entry point is `system/sepolicy/Android.bp`, and the key outputs are `sepolicy` and `vendor_sepolicy.cil`.

The compilation flow roughly looks like:

```text
.te 源文件
  → m4 宏展开
  → 生成 CIL（Common Intermediate Language）
  → secilc 编译成二进制 policy
  → 打包进 system/vendor 分区
```

### Why There Is an Intermediate CIL Layer

After Android 8.0 introduced Treble, system and vendor policies needed to be compiled independently and merged at runtime. The platform publishes its own `plat_sepolicy.cil` first, and the vendor policy is layered on top as `vendor_sepolicy.cil`, avoiding the two sides modifying each other's source code. Version compatibility rules (compat) are also handled at this layer.

There is another easy pitfall at build time: macros are not simple text substitution. `init_daemon_domain(my_service)` expands into a whole set of allow rules covering domain transition rules, exec access, tmpfs directory creation, and so on. Piecing together raw `allow` statements yourself makes it easy to miss basic permissions such as `open`, `getattr`, and `map`.

## Domain Transitions and Access Rules

When init starts my_service, allow rules alone are not enough; you need a Domain Transition. The transition must satisfy four conditions: init must have execute permission on my_service_exec, my_service must have entrypoint permission on the exec file, the policy must declare a type_transition, and init must have transition permission on the my_service process type.

The `init_daemon_domain` macro handles all of these at once. After expansion, the core rules are equivalent to:

```te
allow init my_service_exec:file { execute getattr open map read };
allow my_service my_service_exec:file entrypoint;
allow init my_service:process transition;
type_transition init my_service_exec:process my_service;
```

type_transition only declares "a transition is allowed"; the actual allow rules are what grant permission. Many newcomers misunderstand this: writing type_transition does not mean the process will automatically switch domains — you must also add the matching allow rules.

### The Three Kinds of Contexts Mapping

Besides files, common access targets in Android also include properties, binder services, and directories. `property_contexts`, `service_contexts`, and `file_contexts` respectively establish the "object name to type" mapping. When rules go wrong, the problem is often not the allow rules but incorrectly labeled contexts.

A complete snippet for a vendor service registering with binder:

```te
type my_service, domain;
type my_service_exec, exec_type, file_type, vendor_file_type;

init_daemon_domain(my_service)
binder_use(my_service)
add_service(my_service, my_service)
```

The `binder_use` macro grants access to `/dev/binder`, and `add_service` writes the service name into service_contexts and permits registration. I prefer to reuse the macros directly rather than hand-write binder allow rules, because the class set is large and easy to get wrong by hand.

## neverallow: A Compile-Time Security Red Line

neverallow is a negative assertion in SELinux policy: it declares that "a certain domain must not access a certain type under any circumstances." It does not produce runtime rules; it is only checked at compile time.

Android's platform policy contains a set of red lines, for example:

```te
neverallow { domain -su } { file_type -system_file -vendor_file }:file write;
```

This rule forbids all domains except su from writing to file types other than system_file and vendor_file. To open up access to some file, the target file must belong to a whitelisted type; otherwise the build will fail immediately.

A pitfall I hit: granting a vendor process read permission on `system_data_file` caused the build to report "neverallow violated." My initial thought was "just change the allow rule," but the platform red line simply does not permit it. The correct approach is to have the system side provide a binder interface, or to place the data under a type agreed upon by both sides.

The build error looks like this:

```text
libsepol.report_failure: neverallow on line XXX violated by allow my_service system_data_file:file { read }
```

When you hit this error, don't rush to ignore it with sepolicy-ignore. After Android 12, many neverallow rules are abstracted from security vulnerability models; ignoring one means reintroducing CVE risk into your own project.

## Troubleshooting Pipeline and Practical Advice

Back to that log at the beginning. I usually fix the troubleshooting order to four steps:

1. Confirm the enforcing state: `getenforce`. permissive is only for locating the problem, never a final solution.
2. Capture the full avc log: `adb logcat -b all | grep avc` or `dmesg | grep avc`.
3. Determine whether the issue is a missing rule or a mislabeled context.
4. Use `audit2allow` to generate candidate rules, review them manually, and then write them into `.te`.

Usage of audit2allow:

```bash
adb shell dmesg | grep avc | audit2allow -p out/target/product/xxx/sepolicy
```

It outputs allow suggestions, not a final answer. The tool only converts "denied permissions" into allow rules; it cannot tell whether you should open up a file or switch to binder. In a real project I saw audit2allow suggest granting `:file write` when the business only needed to read a config file; granting write permission was over-authorization.

A more reliable approach is to look at `scontext` and `tcontext` in the avc log and ask two questions: Is the source domain reasonable? Is the target type mislabeled? In many cases, what needs to change is file_contexts, not adding an allow rule to the domain.

When adding a native service or daemon to Android, my current fixed process is:

- First define the type and domain, and reuse macros such as `init_daemon_domain` and `binder_use` instead of writing raw allow rules.
- Configure the file, property, and binder contexts all at once to avoid the "add rules after it runs" loop.
- Carefully read neverallow errors at build time, and treat the platform red lines as security boundaries rather than obstacles.

Writing SELinux policy is tedious, but it extracts "who can touch what" out of the code and turns it into declarations that are compilable, auditable, and versionable. Once you understand this pipeline, avc logs stop being a pile of cryptic strings and become the system clearly telling you where the boundary is.
