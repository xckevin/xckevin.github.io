---
title: "Binder IPC 机制深度解析（Beyond AIDL）（5）：基本 AIDL 实现示例"
excerpt: "「Binder IPC 机制深度解析（Beyond AIDL）」系列第 5/7 篇：基本 AIDL 实现示例"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - Binder
  - IPC
  - AIDL
series:
  name: "Binder IPC 机制深度解析（Beyond AIDL）"
  part: 5
  total: 7
seo:
  title: "Binder IPC 机制深度解析（Beyond AIDL）（5）：基本 AIDL 实现示例"
  description: "「Binder IPC 机制深度解析（Beyond AIDL）」系列第 5/7 篇：基本 AIDL 实现示例"
---
# Binder IPC 机制深度解析（Beyond AIDL）（5）：基本 AIDL 实现示例

> 本文是「Binder IPC 机制深度解析（Beyond AIDL）」系列的第 5 篇，共 7 篇。在上一篇中，我们探讨了「线程模型：并发、同步与 ANR 之源」的相关内容。

## 五、核心对象模型：IBinder、BpBinder、BBinder

理解 Binder 在用户空间的抽象对于编写和调试 Binder 服务至关重要。

- **IBinder 接口：**
  - 定义了 Binder 对象的基本行为，是所有 Binder 对象的公共基类（在 Native C++ 和 Java 层都有对应）。
  - 关键方法：
    - `transact(int code, Parcel data, Parcel reply, int flags)`：核心方法，用于发起或处理事务。code 标识目标方法，data 是输入参数，reply 是输出结果，flags 控制事务行为（如 `FLAG_ONEWAY`）。
    - `linkToDeath(DeathRecipient recipient, int flags)`：注册死亡通知。
    - `unlinkToDeath(DeathRecipient recipient, int flags)`：取消死亡通知。
    - `pingBinder()`：测试对端 Binder 是否存活。
    - `queryLocalInterface(String descriptor)`：尝试获取本地接口（如果 Client 和 Server 在同一进程）。
- **BBinder（Binder Base / Stub）：**
  - 服务端（Service）实现的基类（Native C++）。Java 中对应的是 Binder 类或 AIDL 生成的 Stub 类。
  - 核心方法是 `onTransact(int code, Parcel data, Parcel reply, int flags)`。当 Binder 驱动将事务传递给 Server 进程的 Binder 线程时，最终会调用到目标 BBinder 子类的 `onTransact` 方法。开发者需要在此方法中根据 code 分发请求到具体的业务逻辑，并将结果写入 reply。
- **BpBinder（Binder Proxy）：**
  - 客户端（Client）持有的代理对象（Native C++）。Java 中对应的是 AIDL 生成的 Proxy 类或通过 IBinder 直接操作。
  - 当 Client 调用代理接口方法时，其内部实现会调用 `BpBinder::transact()`（或 Java 层的 `BinderProxy.transact()`），将 code 和打包好的 data Parcel 通过 IPCThreadState 发送给 Binder 驱动。它负责将本地方法调用转换为跨进程的 Binder 事务。

**同一进程内的调用：** 当 Client 和 Server 在同一进程时，`IBinder.queryLocalInterface()` 可以获取到原始的 BBinder（Stub）对象，避免了 Binder 驱动的介入和 Parcel 序列化/反序列化开销，直接进行方法调用，效率更高。AIDL 生成的代码会自动处理这种情况。

### 基本 AIDL 实现示例

1. **AIDL 文件（IMyAidlInterface.aidl）：** 见上一节 oneway 示例。
2. **Parcelable 文件（MyData.java）：** 见上一节 Parcelable 示例。
3. **服务端实现（MyService.java）：**

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

4. **客户端实现（MyClientActivity.java）：**

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

5. **权限声明（AndroidManifest.xml）：**

**服务端 App：**

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

**客户端 App：**

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

> 下一篇我们将探讨「死亡通知（DeathRecipient）：远端死亡的哨兵」，敬请关注本系列。

**「Binder IPC 机制深度解析（Beyond AIDL）」系列目录**

1. 引言：Android 世界的神经网络
2. 深入 Binder 驱动：内核中的魔法师
3. 内存模型与数据传输：一次拷贝的奥秘
4. 线程模型：并发、同步与 ANR 之源
5. **基本 AIDL 实现示例**（本文）
6. 死亡通知（DeathRecipient）：远端死亡的哨兵
7. 疑难问题排查：庖丁解牛 Binder
