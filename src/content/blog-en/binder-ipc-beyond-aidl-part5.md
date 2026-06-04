---
title: "Binder IPC Deep Dive (Beyond AIDL) (5): A Basic AIDL Implementation Example"
lang: en
translationKey: binder-ipc-beyond-aidl-part5
slug: binder-ipc-beyond-aidl-part5
excerpt: "Part 5 of the Binder IPC deep dive series: the IBinder, BBinder, and BpBinder object model plus a complete basic AIDL service and client."
publishDate: '2024-04-21'
displayInBlog: false
tags:
- "Android"
- "Binder"
- "IPC"
- "AIDL"
series:
  name: "Binder IPC Deep Dive (Beyond AIDL)"
  part: 5
  total: 7
seo:
  title: "Android Binder Object Model and a Basic AIDL Implementation"
  description: "Learn how IBinder, BBinder, and BpBinder map to AIDL Stub and Proxy code, then walk through a basic Android AIDL service and client."
  pageType: article
---
> This is part 5 of the seven-part series "Binder IPC Deep Dive (Beyond AIDL)." In the previous article, we explored "Thread Model: Concurrency, Synchronization, and the Source of ANR."

## 5. Core Object Model: IBinder, BpBinder, and BBinder

Understanding Binder's userspace abstractions is essential for writing and debugging Binder services.

- **IBinder interface:**
  - Defines the basic behavior of Binder objects. It is the shared base interface for all Binder objects, with counterparts in both Native C++ and the Java layer.
  - Key methods:
    - `transact(int code, Parcel data, Parcel reply, int flags)`: the core method for starting or handling a transaction. `code` identifies the target method, `data` contains input arguments, `reply` contains output results, and `flags` controls transaction behavior such as `FLAG_ONEWAY`.
    - `linkToDeath(DeathRecipient recipient, int flags)`: registers a death notification.
    - `unlinkToDeath(DeathRecipient recipient, int flags)`: unregisters a death notification.
    - `pingBinder()`: checks whether the remote Binder is alive.
    - `queryLocalInterface(String descriptor)`: attempts to obtain a local interface when the Client and Server are in the same process.
- **BBinder (Binder Base / Stub):**
  - The base class implemented by the Server side in Native C++. In Java, the equivalent is the `Binder` class or an AIDL-generated `Stub` class.
  - Its key method is `onTransact(int code, Parcel data, Parcel reply, int flags)`. When the Binder driver delivers a transaction to a Binder thread in the Server process, the call eventually reaches the target `BBinder` subclass's `onTransact` method. The developer dispatches the request to business logic based on `code` and writes the result into `reply`.
- **BpBinder (Binder Proxy):**
  - The proxy object held by the Client in Native C++. In Java, the equivalent is an AIDL-generated `Proxy` class or direct use of `IBinder`.
  - When the Client calls a proxy interface method, the proxy implementation calls `BpBinder::transact()` or, in Java, `BinderProxy.transact()`. It sends the `code` and packed `data` `Parcel` to the Binder driver through `IPCThreadState`. Its job is to convert a local method call into a cross-process Binder transaction.

**Calls within the same process:** when the Client and Server are in the same process, `IBinder.queryLocalInterface()` can obtain the original `BBinder` or `Stub` object. That avoids Binder driver involvement and Parcel serialization/deserialization overhead, allowing a direct method call. AIDL-generated code handles this case automatically.

### Basic AIDL Implementation Example

1. **AIDL file (`IMyAidlInterface.aidl`):** see the `oneway` example in the previous section.
2. **Parcelable file (`MyData.java`):** see the Parcelable example in the previous section.
3. **Server implementation (`MyService.java`):**

```java
// MyService.java
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;

public class MyService extends Service {
    private static final String TAG = "MyService";
    private static final String PERMISSION_ACCESS_MY_SERVICE = "com.example.binderdemo.permission.ACCESS_MY_SERVICE";

    private final IMyAidlInterface.Stub mBinder = new IMyAidlInterface.Stub() {
        @Override
        public MyData getData(int id) throws RemoteException {
            if (checkCallingOrSelfPermission(PERMISSION_ACCESS_MY_SERVICE) != PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Permission Denial: Requires " + PERMISSION_ACCESS_MY_SERVICE + " for getData");
                throw new SecurityException("Requires permission " + PERMISSION_ACCESS_MY_SERVICE);
            }

            Log.d(TAG, "getData(" + id + ") called by PID=" + Binder.getCallingPid() + ", UID=" + Binder.getCallingUid() + " on thread: " + Thread.currentThread().getName());
            SystemClock.sleep(100);
            return new MyData(id, "Processed data for " + id + " in MyService");
        }

        @Override
        public void notifyServer(String message) throws RemoteException {
            if (checkCallingOrSelfPermission(PERMISSION_ACCESS_MY_SERVICE) != PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Permission Denial: Requires " + PERMISSION_ACCESS_MY_SERVICE + " for notifyServer");
                throw new SecurityException("Requires permission " + PERMISSION_ACCESS_MY_SERVICE);
            }
            Log.d(TAG, "notifyServer(" + message + ") called by PID=" + Binder.getCallingPid() + " on thread: " + Thread.currentThread().getName());
            Log.i(TAG, "Server received notification: " + message);
        }

        @Override
        public void sendMyData(MyData data) throws RemoteException {
            if (checkCallingOrSelfPermission(PERMISSION_ACCESS_MY_SERVICE) != PackageManager.PERMISSION_GRANTED) {
                Log.e(TAG, "Permission Denial: Requires " + PERMISSION_ACCESS_MY_SERVICE + " for sendMyData");
                throw new SecurityException("Requires permission " + PERMISSION_ACCESS_MY_SERVICE);
            }
            Log.d(TAG, "sendMyData called by PID=" + Binder.getCallingPid() + " on thread: " + Thread.currentThread().getName());
            if (data != null) {
                Log.d(TAG, "sendMyData received: " + data.getIntValue() + ", " + data.getStringValue());
            } else {
                Log.w(TAG, "sendMyData received null data");
            }
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        Log.d(TAG, "onBind called, returning binder instance.");
        return mBinder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "Service Created. PID: " + android.os.Process.myPid());
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "Service onStartCommand.");
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "Service Destroyed");
    }
}
```

4. **Client implementation (`MyClientActivity.java`):**

```java
// MyClientActivity.java
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.RemoteException;
import android.util.Log;
import android.widget.Button;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AppCompatActivity;

public class MyClientActivity extends AppCompatActivity {
    private static final String TAG = "MyClientActivity";
    private static final String PERMISSION_ACCESS_MY_SERVICE = "com.example.binderdemo.permission.ACCESS_MY_SERVICE";

    private IMyAidlInterface mService = null;
    private boolean mIsBound = false;
    private TextView mResultTextView;
    private Handler mMainHandler = new Handler(Looper.getMainLooper());

    private ServiceConnection mConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName className, IBinder service) {
            Log.d(TAG, "Service Connected to " + className.flattenToString());
            mService = IMyAidlInterface.Stub.asInterface(service);
            mIsBound = true;
            Log.d(TAG, "Binder instance acquired.");

            try {
                service.linkToDeath(mDeathRecipient, 0);
                Log.d(TAG, "Linked to death recipient");
            } catch (RemoteException e) {
                Log.e(TAG, "Failed to link to death recipient", e);
                mIsBound = false;
                mService = null;
            }
            updateUi("Service Connected");
        }

        @Override
        public void onServiceDisconnected(ComponentName arg0) {
            Log.w(TAG, "Service Disconnected from " + arg0.flattenToString());
            mService = null;
            mIsBound = false;
            updateUi("Service Disconnected");
        }
    };

    private IBinder.DeathRecipient mDeathRecipient = new IBinder.DeathRecipient() {
        @Override
        public void binderDied() {
            Log.e(TAG, "!!! Service process Died !!! Binder hashcode: " + (mService != null ? mService.asBinder().hashCode() : "null"));

            IBinder binder = (mService != null) ? mService.asBinder() : null;
            if (binder != null) {
                binder.unlinkToDeath(mDeathRecipient, 0);
                Log.d(TAG, "Unlinked self in binderDied");
            }

            mService = null;
            mIsBound = false;

            mMainHandler.post(() -> {
                Log.e(TAG, "Updating UI after service death.");
                updateUi("Service Died! Connection lost.");
            });
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        mResultTextView = findViewById(R.id.resultTextView);
        Button bindButton = findViewById(R.id.bindButton);
        Button unbindButton = findViewById(R.id.unbindButton);
        Button callSyncButton = findViewById(R.id.callSyncButton);
        Button callOnewayButton = findViewById(R.id.callOnewayButton);
        Button sendDataButton = findViewById(R.id.sendDataButton);

        bindButton.setOnClickListener(v -> bindToService());
        unbindButton.setOnClickListener(v -> unbindFromService());
        callSyncButton.setOnClickListener(v -> callSyncMethod());
        callOnewayButton.setOnClickListener(v -> callOnewayMethod());
        sendDataButton.setOnClickListener(v -> callSendDataMethod());
    }

    private void bindToService() {
        if (!mIsBound) {
            Log.d(TAG, "Attempting to bind service...");
            Intent intent = new Intent(this, MyService.class);
            boolean success = bindService(intent, mConnection, Context.BIND_AUTO_CREATE);
            if (success) {
                updateUi("Binding initiated...");
            } else {
                updateUi("Binding failed immediately.");
                Log.e(TAG, "bindService returned false. Check service declaration in Manifest?");
            }
        } else {
            updateUi("Already bound to service.");
            Log.w(TAG, "Bind button clicked, but already bound.");
        }
    }

    private void unbindFromService() {
        if (mIsBound) {
            Log.d(TAG, "Attempting to unbind service...");

            if (mService != null && mService.asBinder().isBinderAlive()) {
                try {
                    mService.asBinder().unlinkToDeath(mDeathRecipient, 0);
                    Log.d(TAG, "Unlinked death recipient on unbind");
                } catch (Exception e) {
                    Log.w(TAG, "Failed to unlink death recipient on unbind: " + e.getMessage());
                }
            } else {
                Log.w(TAG, "Service is null or binder not alive during unbind, skipping unlink.");
            }

            unbindService(mConnection);
            mIsBound = false;
            mService = null;
            updateUi("Service Unbound");
        } else {
            updateUi("Already unbound.");
            Log.w(TAG, "Unbind button clicked, but not bound.");
        }
    }

    private void callSyncMethod() {
        if (!mIsBound || mService == null) {
            updateUi("Cannot call sync: Service not bound");
            return;
        }
        updateUi("Calling sync method getData(123)...");
        new Thread(() -> {
            try {
                Log.d(TAG, "Executing mService.getData(123) on thread: " + Thread.currentThread().getName());
                MyData result = mService.getData(123);
                final String resultText = "Sync Result: " + (result != null ? result.getStringValue() : "null");
                mMainHandler.post(() -> updateUi(resultText));
            } catch (RemoteException e) {
                Log.e(TAG, "Sync call failed with RemoteException", e);
                handleRemoteException("Sync call", e);
            } catch (SecurityException se) {
                Log.e(TAG, "Sync call failed due to permission issue", se);
                mMainHandler.post(() -> updateUi("Sync failed: Permission denied. Do you have " + PERMISSION_ACCESS_MY_SERVICE + "?"));
            } catch (Exception ex) {
                Log.e(TAG, "Sync call failed with unexpected exception", ex);
                mMainHandler.post(() -> updateUi("Sync failed: Unexpected error - " + ex.getMessage()));
            }
        }, "BinderSyncCallerThread").start();
    }

    private void callOnewayMethod() {
        if (!mIsBound || mService == null) {
            updateUi("Cannot call oneway: Service not bound");
            return;
        }
        updateUi("Calling oneway method notifyServer...");
        new Thread(() -> {
            try {
                Log.d(TAG, "Executing mService.notifyServer() on thread: " + Thread.currentThread().getName());
                mService.notifyServer("Hello from Client via Oneway!");
                mMainHandler.post(() -> updateUi("Oneway call sent (no reply expected)"));
            } catch (RemoteException e) {
                Log.e(TAG, "Oneway call failed with RemoteException", e);
                handleRemoteException("Oneway call", e);
            } catch (SecurityException se) {
                Log.e(TAG, "Oneway call failed due to permission issue", se);
                mMainHandler.post(() -> updateUi("Oneway failed: Permission denied."));
            } catch (Exception ex) {
                Log.e(TAG, "Oneway call failed with unexpected exception", ex);
                mMainHandler.post(() -> updateUi("Oneway failed: Unexpected error - " + ex.getMessage()));
            }
        }, "BinderOnewayCallerThread").start();
    }

    private void callSendDataMethod() {
        if (!mIsBound || mService == null) {
            updateUi("Cannot send data: Service not bound");
            return;
        }
        updateUi("Calling sendMyData method...");
        new Thread(() -> {
            try {
                MyData dataToSend = new MyData(456, "Some Client Data");
                Log.d(TAG, "Executing mService.sendMyData() on thread: " + Thread.currentThread().getName());
                mService.sendMyData(dataToSend);
                mMainHandler.post(() -> updateUi("Send data call completed (sync)"));
            } catch (RemoteException e) {
                Log.e(TAG, "Send data call failed with RemoteException", e);
                handleRemoteException("Send data call", e);
            } catch (SecurityException se) {
                Log.e(TAG, "Send data failed due to permission issue", se);
                mMainHandler.post(() -> updateUi("Send data failed: Permission denied."));
            } catch (Exception ex) {
                Log.e(TAG, "Send data failed with unexpected exception", ex);
                mMainHandler.post(() -> updateUi("Send data failed: Unexpected error - " + ex.getMessage()));
            }
        }, "BinderDataSenderThread").start();
    }

    private void handleRemoteException(String operation, RemoteException e) {
        final String errorMsg;
        if (e instanceof android.os.DeadObjectException) {
            errorMsg = operation + " failed: Service has died.";
            Log.e(TAG, "DeadObjectException caught during: " + operation);
            mIsBound = false;
            mService = null;
        } else {
            errorMsg = operation + " failed: " + e.getMessage();
        }
        mMainHandler.post(() -> updateUi(errorMsg));
    }

    private void updateUi(final String message) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            Log.d(TAG, "UI Update: " + message);
            mResultTextView.setText(message);
            Toast.makeText(MyClientActivity.this, message, Toast.LENGTH_SHORT).show();
        } else {
            Log.d(TAG, "Posting UI Update: " + message);
            mMainHandler.post(() -> {
                Log.d(TAG, "Executing posted UI Update: " + message);
                mResultTextView.setText(message);
                Toast.makeText(MyClientActivity.this, message, Toast.LENGTH_SHORT).show();
            });
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "Activity onDestroy: Unbinding service...");
        unbindFromService();
    }
}
```

5. **Permission declarations (`AndroidManifest.xml`):**

**Server app:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.binderdemo.server">
    <permission android:name="com.example.binderdemo.permission.ACCESS_MY_SERVICE"
        android:label="Access My Service"
        android:description="@string/permission_description"
        android:protectionLevel="signature" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name_server"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.BinderDemo">
        <service
            android:name=".MyService"
            android:enabled="true"
            android:exported="true">
        </service>
    </application>
</manifest>
```

**Client app:**

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.binderdemo.client">
    <uses-permission android:name="com.example.binderdemo.permission.ACCESS_MY_SERVICE" />

    <queries>
        <package android:name="com.example.binderdemo.server" />
    </queries>

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name_client"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/Theme.BinderDemo">
        <activity
            android:name=".MyClientActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
```

---

---

> In the next article, we will explore "Death Notifications (DeathRecipient): the Sentinel for Remote Death."

**"Binder IPC Deep Dive (Beyond AIDL)" Series**

1. Introduction: the Neural Network of the Android World
2. Inside the Binder Driver: the Magician in the Kernel
3. Memory Model and Data Transfer: the Secret of One Copy
4. Thread Model: Concurrency, Synchronization, and the Source of ANR
5. **A Basic AIDL Implementation Example** (this article)
6. Death Notifications (DeathRecipient): the Sentinel for Remote Death
7. Troubleshooting: Dissecting Binder Like Pao Ding
