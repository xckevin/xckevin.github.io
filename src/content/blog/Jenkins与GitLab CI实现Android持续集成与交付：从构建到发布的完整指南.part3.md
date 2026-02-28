---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（3）：自动化测试集成"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 3/8 篇：自动化测试集成"
publishDate: 2025-09-06
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 3
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（3）：自动化测试集成"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 3/8 篇：自动化测试集成"
---
> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 3 篇，共 8 篇。在上一篇中，我们探讨了「基础构建配置」的相关内容。

## 第四章：自动化测试集成
### 4.1 Android 测试概述

Android 应用测试通常分为三个层次：

- **单元测试（Unit Tests）**：测试单个类或方法，运行在 JVM 上；
  - 位置：`module/src/test/java/`；
  - 框架：JUnit、Mockito、Robolectric 等。
- **仪器化测试（Instrumented Tests）**：在 Android 设备或模拟器上运行的测试；
  - 位置：`module/src/androidTest/java/`；
  - 框架：AndroidX Test、Espresso、UI Automator 等。
- **UI 测试（UI Tests）**：测试用户界面交互；
  - 通常作为仪器化测试的一部分实现。

### 4.2 配置单元测试
#### 4.2.1 Jenkins配置
在构建步骤中添加测试任务：

```plain
tasks: clean testDebugUnitTest
```

添加构建后操作收集测试结果：

- 添加「Publish JUnit test result」；
- Test report XMLs：`app/build/test-results/testDebugUnitTest/**/*.xml`。

添加代码覆盖率报告：

确保在 `build.gradle` 中配置了 JaCoCo：

```groovy
android {

    testOptions {

        unitTests.all {

            jacoco {

                includeNoLocationClasses = true

                excludes = ['jdk.internal.*']

            }

        }

    }

}
```

添加构建步骤：

```plain
tasks: jacocoTestReport
```

添加「Record JaCoCo coverage report」后构建操作。

#### 4.2.2 GitLab CI配置
```yaml
unit_test:
  stage: test
  tags:
    - android
  script:
    - ./gradlew testDebugUnitTest jacocoTestReport
  artifacts:
    paths:
      - app/build/reports/tests/testDebugUnitTest/
      - app/build/reports/jacoco/jacocoTestReport/
    expire_in: 1 week
  coverage: '/Total.*?([0-9]{1,3})%/'
```

### 4.3 配置仪器化测试
仪器化测试需要在 Android 设备或模拟器上运行。在 CI 环境中，我们可以使用：

- **物理设备**：连接到 CI 服务器的真实设备；
- **模拟器**：在 CI 服务器上启动 Android 模拟器；
- **Firebase Test Lab**：云测试服务；
- **第三方服务**：如 BrowserStack、Sauce Labs 等。

#### 4.3.1 使用模拟器运行仪器化测试
**Jenkins 配置**：

- 安装 Android Emulator Plugin；
- 在构建环境中勾选「Android Emulator」；
- 配置模拟器：
  - Android SDK：选择已配置的 Android SDK；
  - AVD 名称：ci-emulator；
  - 系统镜像：例如 `system-images;android-30;google_apis;x86_64`；
  - 屏幕密度：240；
  - 屏幕分辨率：1080x1920；
  - 设备区域：en_US；
  - 设备语言：en；
  - 其他选项：根据需要配置调整。
- 添加构建步骤运行测试：

```plain
tasks: connectedDebugAndroidTest
```

收集测试结果：

JUnit报告路径：app/build/outputs/androidTest-results/connected/**/*.xml

覆盖率报告：如果配置了JaCoCo，路径为app/build/reports/coverage/androidTest/debug/

**GitLab CI配置**：

使用Docker-in-Docker或特权模式运行模拟器：

```yaml
instrumented_test:
  stage: test
  tags:
    - android
  services:
    - docker:dind
  variables:
    DOCKER_DRIVER: overlay2
    DOCKER_HOST: tcp://docker:2375
  script:
    # 启动模拟器容器
    - docker run --detach --privileged --name emulator --publish 5554:5554 --publish 5555:5555 
      -e ADBKEY="$(cat ~/.android/adbkey)" android-emulator:30
    - adb wait-for-device
    - ./gradlew connectedDebugAndroidTest
  artifacts:
    paths:
      - app/build/reports/androidTests/connected/
      - app/build/outputs/androidTest-results/connected/
    expire_in: 1 week
```

#### 4.3.2 使用Firebase Test Lab
对于更全面的测试，可以使用 Firebase Test Lab：

- 设置 Firebase 项目并启用 Test Lab；
- 创建服务账户并下载 JSON 密钥文件；
- 在 CI 中配置密钥。

**Jenkins 配置**：

- 将 Firebase 密钥作为机密文件添加到 Jenkins；

添加构建步骤：

```groovy
withCredentials([file(credentialsId: 'firebase-key', variable: 'FIREBASE_KEY')]) {
    sh """
    export FIREBASE_KEY_PATH=\$(mktemp)
    cp \$FIREBASE_KEY \$FIREBASE_KEY_PATH
    gcloud auth activate-service-account --key-file=\$FIREBASE_KEY_PATH
    gcloud --quiet config set project your-project-id
    ./gradlew app:assembleDebug app:assembleDebugAndroidTest
    gcloud firebase test android run \\
        --type instrumentation \\
        --app app/build/outputs/apk/debug/app-debug.apk \\
        --test app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk \\
        --device model=Pixel2,version=30,locale=en,orientation=portrait \\
        --timeout 20m
    rm \$FIREBASE_KEY_PATH
    """
}
```

**GitLab CI配置**：

```yaml
firebase_test:
  stage: test
  tags:
    - android
  before_script:
    - apt-get update && apt-get install -y curl
    - curl -sSL https://sdk.cloud.google.com | bash
    - source ~/.bashrc
    - echo $FIREBASE_KEY > /tmp/firebase-key.json
    - gcloud auth activate-service-account --key-file=/tmp/firebase-key.json
    - gcloud --quiet config set project your-project-id
  script:
    - ./gradlew app:assembleDebug app:assembleDebugAndroidTest
    - gcloud firebase test android run
        --type instrumentation
        --app app/build/outputs/apk/debug/app-debug.apk
        --test app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
        --device model=Pixel2,version=30,locale=en,orientation=portrait
        --timeout 20m
  artifacts:
    reports:
      junit: app/build/outputs/androidTest-results/connected/**/*.xml
```

### 4.4 测试报告与可视化
#### 4.4.1 Jenkins 测试报告

**JUnit 报告**：

- 安装 JUnit Plugin；
- 在「Post-build Actions」中添加「Publish JUnit test result」；
- 指定测试结果路径，如 `**/test-results/**/*.xml`。

**JaCoCo 覆盖率报告**：

- 安装 JaCoCo Plugin；
- 在「Post-build Actions」中添加「Record JaCoCo coverage report」；
- 配置包含/排除模式。

**HTML 报告**：

- 安装 HTML Publisher Plugin；
- 添加「Publish HTML reports」后构建操作；
- 指定 HTML 报告目录，如 `app/build/reports/`。

#### 4.4.2 GitLab测试报告
GitLab自动解析JUnit格式的测试报告：

```yaml
artifacts:
  reports:
    junit: app/build/test-results/**/*.xml
    cobertura: app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml
```

覆盖率可视化：

```yaml
coverage: '/Total.*?([0-9]{1,3})%/'
```

#### 4.4.3 自定义HTML报告
创建自定义测试报告：

在构建脚本中生成HTML报告

保存为artifact

```yaml
generate_report:
  stage: test
  script:
    - ./gradlew generateTestReport
  artifacts:
    paths:
      - app/build/reports/custom-test-report.html
```

---

> 下一篇我们将探讨「代码质量检查」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. **自动化测试集成**（本文）
4. 代码质量检查
5. 自动化发布与部署
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
