---
title: Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南
excerpt: 在当今快速迭代的移动应用开发环境中，持续集成（Continuous Integration，CI）和持续交付（Continuous Delivery，CD）已成为现代软件开发流程中不可或缺的一部分。对于 Android 开发团队而言，建立一套高效、可靠的自动化构建、测试和发布系统，能够显著提高开发效率、减少人为错误并加速产品交付周期。
publishDate: 2025-09-06
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
seo:
  title: Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南
  description: Jenkins与GitLab CI实现Android持续集成与交付：用 Jenkins 与 GitLab CI 构建 Android CI/CD 管道，实现自动化构建、测试与一键发布，提升交付效率。
---
![](../../assets/jenkins与gitlab-ci实现android持续集成与交付从构建到发布的完整指南-1.png)

## 前言

在当今快速迭代的移动应用开发环境中，持续集成（Continuous Integration，CI）和持续交付（Continuous Delivery，CD）已成为现代软件开发流程中不可或缺的一部分。对于 Android 开发团队而言，建立一套高效、可靠的自动化构建、测试和发布系统，能够显著提高开发效率、减少人为错误并加速产品交付周期。

本文将全面探讨如何使用 Jenkins 和 GitLab CI 这两种主流的 CI/CD 工具来实现 Android 项目的持续集成与交付。我们将从基础概念讲起，逐步深入到高级配置和优化技巧，涵盖构建自动化、测试执行、代码质量检查、报告生成以及应用发布等完整流程。

无论您是刚开始接触 CI/CD 的新手，还是希望优化现有流程的经验丰富的开发者，本文都将为您提供实用的指导和深入的见解。我们将通过详细的配置示例、代码片段和最佳实践，帮助您构建一个健壮的 Android CI/CD 管道。

## 第一章：持续集成基础与工具选择
### 1.1 持续集成的核心概念

持续集成是一种软件开发实践，要求开发人员频繁地将代码变更集成到共享的主干分支中。每次集成都通过自动化构建和测试来验证，以便尽早发现集成错误。

**持续集成的核心价值**：

- **快速反馈**：开发者提交代码后立即获得构建和测试结果反馈；
- **早期发现问题**：在开发周期早期发现集成问题和缺陷；
- **减少集成风险**：避免长期分支导致的复杂合并冲突；
- **可部署的软件**：始终保持一个可部署的软件版本。

对于 Android 开发而言，持续集成特别重要，因为：

- Android 应用需要构建成 APK 或 AAB 文件才能运行；
- 需要在多种设备和 API 级别上进行测试；
- 发布流程复杂，涉及签名、渠道打包等步骤。

### 1.2 Jenkins 与 GitLab CI 的比较

在选择 CI/CD 工具时，Jenkins 和 GitLab CI 是两个最受欢迎的选择。下面我们对它们进行详细比较：

| 特性 | Jenkins | GitLab CI |
| --- | --- | --- |
| **架构** | 主从架构，可分布式执行 | 基于 Runner，可分布式执行 |
| **安装与维护** | 需要独立服务器，维护成本较高 | 与 GitLab 集成，维护简单 |
| **配置方式** | 基于 Web UI 或 Groovy DSL | 基于 YAML 文件（.gitlab-ci.yml） |
| **扩展性** | 插件生态系统丰富，高度可扩展 | 功能较为集中，扩展性适中 |
| **集成** | 可与多种工具集成，但需要配置 | 与 GitLab 深度集成，其他工具需配置 |
| **学习曲线** | 较陡峭 | 相对平缓 |
| **社区支持** | 非常活跃，文档丰富 | 活跃，文档良好 |
| **适用场景** | 复杂项目，需要高度定制化 | GitLab 用户，希望简单 CI/CD 解决方案 |

### 1.3 工具选择建议

基于以上比较，我们可以给出以下建议：

**选择 Jenkins 时**：

- 项目非常复杂，需要高度定制化的构建流程；
- 已经使用 Jenkins 并对其熟悉；
- 需要与多种不同的工具和服务集成；
- 项目不托管在 GitLab 上。

**选择 GitLab CI 时**：

- 代码已经托管在 GitLab 上；
- 希望配置简单、维护成本低；
- 项目相对标准，不需要高度定制化；
- 团队规模较小，资源有限。

在实际工作中，两种工具也可以结合使用，发挥各自的优势。例如，可以使用 GitLab CI 处理代码提交后的初步构建和测试，而使用 Jenkins 进行更复杂的发布流程和后期测试。

## 第二章：环境准备与基础配置

### 2.1 硬件与软件需求

在开始配置 CI/CD 流程前，需要确保有适当的环境。以下是运行 Android CI/CD 的基本要求：

**硬件需求**：

- **CPU**：至少 4 核（推荐 8 核或更高，特别是并行运行多个构建时）；
- **内存**：至少 8GB（推荐 16GB，大型项目可能需要 32GB）；
- **存储**：至少 100GB SSD（Android 构建会产生大量缓存文件）；
- **网络**：稳定高速的网络连接（用于下载依赖和上传构建产物）。

**软件需求**：

- **操作系统**：Linux（推荐 Ubuntu LTS 或 CentOS），macOS 或 Windows 也可；
- **Java 开发工具包（JDK）**：Android 开发需要 JDK 8 或 11，最新建议使用 17（推荐 AdoptOpenJDK）；
- **Android SDK**：最新稳定版，包含必要的平台工具和构建工具；
- **Docker**（可选）：用于容器化构建环境，确保一致性；
- **版本控制系统**：Git。

### 2.2 Jenkins 安装与初始配置

#### 2.2.1 Jenkins 安装

在 Ubuntu 系统上安装 Jenkins 的步骤：

```bash
# 1. 添加Jenkins仓库密钥
wget -q -O - https://pkg.jenkins.io/debian/jenkins.io.key | sudo apt-key add -

# 2. 添加Jenkins仓库到源列表
sudo sh -c 'echo deb http://pkg.jenkins.io/debian-stable binary/ > /etc/apt/sources.list.d/jenkins.list'

# 3. 更新包索引
sudo apt-get update

# 4. 安装Jenkins
sudo apt-get install jenkins

# 5. 启动Jenkins服务
sudo systemctl start jenkins

# 6. 设置Jenkins开机自启
sudo systemctl enable jenkins
```

安装完成后，Jenkins 将在默认的 8080 端口运行。通过浏览器访问 `http://your-server-ip:8080`，按照初始设置向导完成配置。

#### 2.2.2 初始安全配置

从日志中获取初始管理员密码：

```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

在 Web 界面输入密码后，选择「Install suggested plugins」安装推荐插件。

- 创建第一个管理员用户；
- 配置实例 URL，通常保持默认即可。

#### 2.2.3 安装必要插件

对于 Android CI/CD，需要安装以下关键插件：

- **Android Emulator Plugin**：用于管理 Android 模拟器；
- **Git Plugin**：Git 集成支持；
- **Gradle Plugin**：Gradle 构建支持；
- **Pipeline**：定义构建管道；
- **HTML Publisher**：发布 HTML 格式的报告；
- **JUnit**：处理 JUnit 测试结果；
- **JaCoCo**：代码覆盖率支持；
- **SonarQube Scanner**（可选）：代码质量分析；
- **Google Play Android Publisher**（可选）：发布应用到 Google Play。

安装插件步骤：

1. 进入「Manage Jenkins」>「Manage Plugins」；
2. 选择「Available」标签页；
3. 搜索上述插件并勾选；
4. 点击「Install without restart」或「Download now and install after restart」。

#### 2.2.4 配置全局工具
在「Manage Jenkins」>「Global Tool Configuration」中配置：

- **JDK**：
  - 名称：jdk17；
  - JAVA_HOME：`/usr/lib/jvm/java-17-openjdk-amd64`。
- **Git**：
  - 名称：Default；
  - Path to Git executable：`git`。
- **Gradle**：
  - 名称：gradle-8.4；
  - 勾选「Install automatically」；
  - 选择版本：8.4；
  - 其他选项保持默认。

### 2.3 GitLab CI Runner安装与配置
#### 2.3.1 安装GitLab Runner
在Ubuntu系统上安装GitLab Runner：

```bash
# 1. 添加官方仓库
curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | sudo bash

# 2. 安装最新版GitLab Runner
sudo apt-get install gitlab-runner

# 3. 验证安装
gitlab-runner --version
```

#### 2.3.2 注册Runner
在GitLab项目中，进入"Settings" > "CI/CD" > "Runners"

找到"Set up a specific Runner manually"部分的URL和token

在服务器上运行注册命令：

```bash
sudo gitlab-runner register
```

按照提示输入：

GitLab实例URL：https://gitlab.xxx-host.com/

注册token：从GitLab界面获取

描述：android-runner

标签：android, docker（可选）

执行器：docker（推荐）或shell

如果选择docker执行器，还需要指定默认的docker镜像，如docker:stable

#### 2.3.3 配置Runner
编辑Runner配置文件（通常在/etc/gitlab-runner/config.toml），确保有以下配置：

```toml
concurrent = 4
check_interval = 0

[session_server]
  session_timeout = 1800

[[runners]]
  name = "android-runner"
  url = "https://gitlab.com/"
  token = "YOUR_TOKEN"
  executor = "docker"
  [runners.docker]
    tls_verify = false
    image = "alpine:latest"
    privileged = false
    disable_entrypoint_overwrite = false
    oom_kill_disable = false
    disable_cache = false
    volumes = ["/cache"]
    shm_size = 0
  [runners.cache]
    [runners.cache.s3]
    [runners.cache.gcs]
```

#### 2.3.4 安装Docker（如果使用Docker执行器）
```bash
# 1. 安装必要依赖
sudo apt-get install apt-transport-https ca-certificates curl gnupg-agent software-properties-common

# 2. 添加Docker官方GPG密钥
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -

# 3. 添加Docker仓库
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"

# 4. 更新包索引并安装Docker
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io

# 5. 将当前用户添加到docker组（避免每次使用sudo）
sudo usermod -aG docker $USER
sudo usermod -aG docker gitlab-runner

# 6. 重启docker服务
sudo systemctl restart docker
```

### 2.4 Android SDK配置
无论使用Jenkins还是GitLab CI，都需要正确配置Android SDK。

#### 2.4.1 安装Android命令行工具
```bash
# 1. 创建Android SDK目录
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools

# 2. 下载命令行工具（版本可能更新，请检查最新）
wget https://dl.google.com/android/repository/commandlinetools-linux-6858069_latest.zip
unzip commandlinetools-linux-6858069_latest.zip
mv cmdline-tools latest

# 3. 添加环境变量
echo 'export ANDROID_HOME=$HOME/android-sdk' >> ~/.bashrc
echo 'export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools' >> ~/.bashrc
source ~/.bashrc

# 4. 接受许可证
yes | sdkmanager --licenses

# 5. 安装基本工具和平台
sdkmanager "platform-tools" "platforms;android-30" "build-tools;30.0.3"
```

#### 2.4.2 在Jenkins中配置Android SDK
进入「Manage Jenkins」>「Global Tool Configuration」：

- 找到「Android SDK」部分；
- 点击「Add Android SDK」按钮；
- 配置如下：
  - 名称：android-sdk-latest；
  - 取消勾选「Install automatically」；
  - Android SDK home：`/home/jenkins/android-sdk`（根据实际路径调整）。

#### 2.4.3 在GitLab Runner中配置Android SDK
如果使用Docker执行器，建议创建一个自定义Docker镜像包含Android SDK：

```dockerfile
# Dockerfile.android
FROM openjdk:17-jdk

# 安装基本工具
RUN apt-get update && apt-get install -y \
    git \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# 设置环境变量
ENV ANDROID_HOME /opt/android-sdk
ENV PATH ${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

# 下载并安装Android SDK
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    cd ${ANDROID_HOME}/cmdline-tools && \
    wget https://dl.google.com/android/repository/commandlinetools-linux-6858069_latest.zip -O cmdline-tools.zip && \
    unzip cmdline-tools.zip && \
    mv cmdline-tools latest && \
    rm cmdline-tools.zip

# 接受许可证并安装组件
RUN yes | sdkmanager --licenses && \
    sdkmanager "platform-tools" "platforms;android-30" "build-tools;30.0.3"

WORKDIR /app
```

构建并推送镜像：

```bash
docker build -t android-ci-image -f Dockerfile.android .
docker tag android-ci-image your-registry/android-ci-image:latest
docker push your-registry/android-ci-image:latest
```

然后在.gitlab-ci.yml中使用这个镜像：

```yaml
image: your-registry/android-ci-image:latest
```

## 第三章：基础构建配置
### 3.1 Android 项目结构回顾

在配置 CI/CD 之前，理解标准的 Android 项目结构很重要。典型的 Android 项目包含以下关键部分：

```plain
my-android-app/
├── app/                # 主模块
│   ├── build.gradle    # 模块级构建配置
│   ├── src/
│   │   ├── main/       # 主源代码
│   │   ├── test/       # 单元测试
│   │   └── androidTest # 仪器化测试
├── build.gradle        # 项目级构建配置
├── settings.gradle     # 项目设置
├── gradle.properties  # Gradle属性
└── gradlew             # Gradle包装器脚本
```

### 3.2 Jenkins基础构建配置
#### 3.2.1 创建自由风格项目

- 在 Jenkins 仪表板，点击「New Item」；
- 输入项目名称，如「Android-CI」；
- 选择「Freestyle project」，点击「OK」。

#### 3.2.2 配置源代码管理

在「Source Code Management」部分：

- 选择「Git」；
- 输入 Repository URL（如 GitHub 或 GitLab 仓库 URL）；
- 根据需要配置凭据（Credentials）；
- 指定分支（如 `*/main` 或 `*/develop`）。

#### 3.2.3 配置构建触发器
在「Build Triggers」部分，选择适合的触发器：

- **Poll SCM**：定期检查代码变更；
  - 日程表：`H/5 * * * *`（每 5 分钟检查一次）。
- **GitHub/GitLab hook**：代码推送时触发（需要额外配置 webhook）。

#### 3.2.4 配置构建环境

- 勾选「Provide Configuration files」（如果需要）；
- 勾选「Use secret text(s) or file(s)」（如果需要安全凭证）。

在「Build Environment」部分，可以：

- 勾选「Delete workspace before build starts」（清理工作区）；
- 勾选「Add timestamps to the Console Output」（日志加时间戳）。

#### 3.2.5 配置构建步骤

在「Build」部分，点击「Add build step」

选择「Invoke Gradle script」，配置如下：

- 选择 Gradle 版本：gradle-8.4（之前配置的）；
- Tasks：`clean assembleDebug`（或 `assembleRelease`）；
- 勾选「Make gradlew executable」（首次构建时）。

#### 3.2.6 配置构建后操作
在「Post-build Actions」部分，点击「Add post-build action」：

1. 选择「Archive the artifacts」；
   - Files to archive：`app/build/outputs/apk/debug/*.apk`。
2. 添加「Publish JUnit test result」；
   - Test report XMLs：`app/build/test-results/**/*.xml`。
3. 添加「Record JaCoCo coverage report」；
   - 配置覆盖率报告路径。

#### 3.2.7 保存并运行构建

点击「Save」，然后点击「Build Now」进行首次构建。

### 3.3 GitLab CI基础配置
GitLab CI 使用项目根目录下的 `.gitlab-ci.yml` 文件定义构建流程。

#### 3.3.1 创建基础配置文件

```yaml
# .gitlab-ci.yml
stages:
  - build
  - test
  - deploy

variables:
  ANDROID_COMPILE_SDK: "30"
  ANDROID_BUILD_TOOLS: "30.0.3"
  ANDROID_SDK_TOOLS: "6858069"

# 缓存配置
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .gradle/
    - app/build/

build:
  stage: build
  tags:
    - android
  script:
    - export GRADLE_USER_HOME=$(pwd)/.gradle
    - chmod +x gradlew
    - ./gradlew assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
    expire_in: 1 week
```

#### 3.3.2 配置说明

- **stages**：定义构建流程的阶段；
- **variables**：设置环境变量，便于维护和修改；
- **cache**：缓存 Gradle 和构建输出，加速后续构建；
- **build job**：
  - `stage`：属于 build 阶段；
  - `tags`：指定运行此作业的 runner 标签；
  - `script`：执行的命令；
  - `artifacts`：保存构建产物，可供后续阶段使用。

#### 3.3.3 高级缓存配置
为了更有效地利用缓存，可以优化配置：

```yaml
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .gradle/wrapper
    - .gradle/caches
    - app/build/intermediates/compile_only_not_namespaced_r_class_jar/debug
    - app/build/intermediates/bundle_manifest/debug
    - app/build/intermediates/merged_manifests/debug
    - app/build/intermediates/annotation_processor_list/debug
    - app/build/intermediates/compile_library_classes_jar/debug
    - app/build/intermediates/generated_proguard_file/debug
    - app/build/intermediates/incremental/mergeDebugResources
    - app/build/intermediates/incremental/packageDebugResources
    - app/build/intermediates/javac/debug
    - app/build/intermediates/processed_res/debug
    - app/build/intermediates/res/merged/debug
    - app/build/intermediates/symbols/debug
    - app/build/outputs
  policy: pull-push
```

#### 3.3.4 多模块项目配置
对于多模块项目，可以扩展构建配置：

```yaml
build:
  stage: build
  tags:
    - android
  script:
    - export GRADLE_USER_HOME=$(pwd)/.gradle
    - chmod +x gradlew
    - ./gradlew :app:assembleDebug :library:assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
      - library/build/outputs/aar/*.aar
    expire_in: 1 week
```

### 3.4 Gradle构建优化
为了加速 CI 构建，可以在 `gradle.properties` 中添加以下配置：

```properties
# 并行构建
org.gradle.parallel=true
# 启用构建缓存
org.gradle.caching=true
# 启用配置缓存（Gradle 6.6+）
org.gradle.unsafe.configuration-cache=true
# JVM内存配置
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
# 禁用Gradle守护进程（在CI环境中）
org.gradle.daemon=false
```

对于Jenkins，可以在构建步骤中添加这些参数：

```plain
tasks: clean assembleDebug
switches: --build-cache --parallel --max-workers=4
```

对于GitLab CI，可以在脚本中添加：

```yaml
script:
  - ./gradlew assembleDebug --build-cache --parallel --max-workers=4
```

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

## 第五章：代码质量检查
### 5.1 静态代码分析工具
Android 开发中常用的静态代码分析工具：

- **Android Lint**：官方静态分析工具，检查潜在问题和优化建议；
- **Checkstyle**：代码风格检查；
- **PMD**：检测常见编程缺陷；
- **FindBugs/SpotBugs**：查找代码中的 bug 模式；
- **Detekt**（Kotlin 项目）：Kotlin 静态分析工具；
- **SonarQube**：综合代码质量平台。

### 5.2 配置Android Lint
#### 5.2.1 Gradle 配置

在 `build.gradle` 中添加 lint 配置：

```groovy
android {
    lintOptions {
        abortOnError true
        warningsAsErrors true
        checkAllWarnings true
        htmlReport true
        htmlOutput file("${buildDir}/reports/lint/lint-report.html")
        xmlReport true
        xmlOutput file("${buildDir}/reports/lint/lint-report.xml")
        sarifReport true
        sarifOutput file("${buildDir}/reports/lint/lint-report.sarif")
    }
}
```

#### 5.2.2 Jenkins集成
添加构建步骤：

```plain
tasks: lintDebug
```

添加后构建操作发布报告：

HTML Publisher：app/build/reports/lint/lint-report.html

若需要在 Lint 检查失败时使构建失败，可以添加脚本：

```groovy
def lintTask = tasks.getByPath(':app:lintDebug')

if (lintTask.outputFile.text.contains("errors")) {

    error("Lint检查发现错误")

}
```

#### 5.2.3 GitLab CI集成
```yaml
lint:
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true  # 根据需要设置为 true 或 false
```

### 5.3 配置Checkstyle
#### 5.3.1 添加 Checkstyle 插件

在 `build.gradle` 中：

```groovy
plugins {
    id 'checkstyle'
}

checkstyle {
    toolVersion '8.42'
    configFile file("${project.rootDir}/config/checkstyle/checkstyle.xml")
    configProperties = ['checkstyle.cache.file': "${buildDir}/checkstyle.cache"]
    ignoreFailures false
    showViolations true
}

task checkstyle(type: Checkstyle) {
    source 'src'
    include '**/*.java'
    exclude '**/gen/**', '**/test/**', '**/androidTest/**'
    classpath = files()
}
```

#### 5.3.2 配置文件示例
config/checkstyle/checkstyle.xml:

```xml
<?xml version="1.0"?>
<!DOCTYPE module PUBLIC
        "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN"
        "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
    <property name="charset" value="UTF-8"/>
    <property name="severity" value="error"/>
    
    <module name="FileTabCharacter"/>
    <module name="TreeWalker">
        <module name="JavadocMethod"/>
        <module name="MethodName"/>
        <module name="ParameterNumber">
            <property name="max" value="5"/>
        </module>
    </module>
</module>
```

#### 5.3.3 CI集成
**Jenkins**:

添加构建步骤：

```plain
tasks: checkstyle
```

发布HTML报告：

路径：app/build/reports/checkstyle/checkstyle.html

**GitLab CI**:

```yaml
checkstyle:
  stage: test
  script:
    - ./gradlew checkstyle
  artifacts:
    paths:
      - app/build/reports/checkstyle/
    expire_in: 1 week
```

### 5.4 集成SonarQube
#### 5.4.1 SonarQube 服务器安装

- 下载 SonarQube 社区版：[https://www.sonarqube.org/downloads/](https://www.sonarqube.org/downloads/)；
- 解压并运行：

```bash
./bin/linux-x86-64/sonar.sh start
```

访问 `http://localhost:9000`，默认账号为 admin/admin。

#### 5.4.2 Gradle 配置

在 `build.gradle` 中：

```groovy
plugins {
    id "org.sonarqube" version "3.3"
}

sonarqube {
    properties {
        property "sonar.projectKey", "your-project-key"
        property "sonar.host.url", "http://your-sonar-server:9000"
        property "sonar.login", project.hasProperty('sonarToken') ? sonarToken : ""
        property "sonar.android.lint.report", "build/reports/lint/lint-report.xml"
        property "sonar.java.checkstyle.reportPaths", "build/reports/checkstyle/checkstyle.xml"
        property "sonar.coverage.jacoco.xmlReportPaths", "build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml"
    }
}
```

#### 5.4.3 CI集成
**Jenkins**:

安装SonarQube Scanner插件

在"Manage Jenkins" > "Configure System"中配置SonarQube服务器

添加构建步骤：

```plain
tasks: sonarqube

-Dsonar.login=$SONAR_TOKEN
```

**GitLab CI**:

```yaml
sonarqube:
  stage: test
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
  only:
    - master
    - develop
```

### 5.5 质量门禁与构建阻断
配置质量门禁，当代码质量不达标时阻断构建：

#### 5.5.1 Jenkins配置
```groovy
stage('Quality Gate') {
    steps {
        script {
            def qualityGate = waitForQualityGate()
            if (qualityGate.status != 'OK') {
                error "质量门禁未通过: ${qualityGate.status}"
            }
        }
    }
}
```

#### 5.5.2 GitLab CI配置
```yaml
quality_gate:
  stage: test
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
    - >
      curl --fail --user $SONAR_TOKEN:
      "$SONAR_HOST_URL/api/qualitygates/project_status?projectKey=$SONAR_PROJECT_KEY"
      | grep -q '"status":"OK"'
  allow_failure: false
```

## 第六章：自动化发布与部署
### 6.1 构建变体与签名配置
#### 6.1.1 配置构建类型和产品风味
在app/build.gradle中：

```groovy
android {
    buildTypes {
        debug {
            applicationIdSuffix ".debug"
            debuggable true
        }
        release {
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
            signingConfig signingConfigs.release
        }
    }
    
    flavorDimensions "environment"
    productFlavors {
        dev {
            dimension "environment"
            applicationIdSuffix ".dev"
            versionNameSuffix "-dev"
        }
        prod {
            dimension "environment"
        }
    }
    
    signingConfigs {
        release {
            storeFile file("keystore.jks")
            storePassword System.getenv("STORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
}
```

#### 6.1.2 安全存储签名信息
**Jenkins**：

在「Manage Jenkins」>「Manage Credentials」中添加凭据：

- Kind：Secret text；
- Scope：Global；
- Secret：[your_store_password]；
- ID：STORE_PASSWORD。

在构建配置中使用凭据：

```groovy
withCredentials([string(credentialsId: 'STORE_PASSWORD', variable: 'STORE_PASSWORD'),

                string(credentialsId: 'KEY_ALIAS', variable: 'KEY_ALIAS'),

                string(credentialsId: 'KEY_PASSWORD', variable: 'KEY_PASSWORD')]) {

    sh './gradlew assembleRelease'

}
```

**GitLab CI**：

在「Settings」>「CI/CD」>「Variables」中添加变量：

- STORE_PASSWORD；
- KEY_ALIAS；
- KEY_PASSWORD；
- 勾选「Mask variable」和「Protect variable」。

在 `.gitlab-ci.yml` 中：

```yaml
build_release:

  stage: build

  script:

    - ./gradlew assembleRelease

  only:

    - tags
```

### 6.2 发布到内部渠道
#### 6.2.1 发布到内部Web服务器
**Jenkins**:

```groovy
stage('Deploy Internal') {
    steps {
        sshagent(['web-server-credentials']) {
            sh """
            scp app/build/outputs/apk/release/app-release.apk \
                user@webserver:/var/www/downloads/app-${BUILD_NUMBER}.apk
            """
        }
    }
}
```

**GitLab CI**:

```yaml
deploy_internal:
  stage: deploy
  script:
    - apt-get update && apt-get install -y openssh-client
    - mkdir -p ~/.ssh
    - echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
    - chmod 600 ~/.ssh/id_rsa
    - scp app/build/outputs/apk/release/app-release.apk user@webserver:/var/www/downloads/app-${CI_COMMIT_TAG}.apk
  only:
    - tags
```

#### 6.2.2 发布到Firebase App Distribution
**Jenkins**:

```groovy
stage('Firebase App Distribution') {
    steps {
        withCredentials([file(credentialsId: 'firebase-key', variable: 'FIREBASE_KEY')]) {
            sh """
            export FIREBASE_KEY_PATH=\$(mktemp)
            cp \$FIREBASE_KEY \$FIREBASE_KEY_PATH
            ./gradlew assembleRelease
            firebase appdistribution:distribute app/build/outputs/apk/release/app-release.apk \\
                --app 1:1234567890:android:abcdef1234567890 \\
                --groups "qa-team" \\
                --token $(cat \$FIREBASE_KEY_PATH | jq -r '.client_email')
            rm \$FIREBASE_KEY_PATH
            """
        }
    }
}
```

**GitLab CI**:

```yaml
firebase_distribution:
  stage: deploy
  script:
    - curl -sL https://firebase.tools | bash
    - echo "$FIREBASE_KEY" > /tmp/firebase-key.json
    - ./gradlew assembleRelease
    - firebase appdistribution:distribute app/build/outputs/apk/release/app-release.apk
        --app 1:1234567890:android:abcdef1234567890
        --groups "qa-team"
        --token $(cat /tmp/firebase-key.json | jq -r '.client_email')
  only:
    - tags
```

### 6.3 发布到Google Play
#### 6.3.1 准备 Google Play API 访问

- 在 Google Play Console 创建服务账户；
- 下载 JSON 密钥文件；
- 在 CI 系统中配置密钥。

#### 6.3.2 Jenkins 配置

- 安装「Google Play Android Publisher」插件；
- 添加凭据：
  - Kind：Google Service Account from private key；
  - 上传 JSON 密钥文件。
- 在构建配置中添加步骤：

```groovy
stage('Deploy to Google Play') {

    steps {

        googlePlayUploader(

            applicationId: 'com.your.package',

            credentialsId: 'google-play-credentials',

            apkFiles: 'app/build/outputs/apk/release/app-release.apk',

            trackName: 'internal',

            rolloutPercentage: '100'

        )

    }

}
```

#### 6.3.3 GitLab CI配置
```yaml
deploy_play_store:
  stage: deploy
  script:
    - mkdir -p ~/.android
    - echo "$GOOGLE_PLAY_KEY" > ~/.android/google-play-key.json
    - ./gradlew publishReleaseBundle
  only:
    - tags
```

在 `build.gradle` 中配置发布插件：

```groovy
plugins {
    id 'com.github.triplet.play' version '3.7.0'
}

play {
    serviceAccountCredentials = file("${System.getenv('HOME')}/.android/google-play-key.json")
    defaultToAppBundles = true
    track = 'internal'
}
```

### 6.4 版本管理与变更日志
#### 6.4.1 自动版本号管理

在 `build.gradle` 中：

```groovy
def getVersionCode = { ->
    def code = System.getenv("VERSION_CODE") ?: "1"
    return code.toInteger()
}

def getVersionName = { ->
    def name = System.getenv("VERSION_NAME") ?: "1.0.0"
    return name
}

android {
    defaultConfig {
        versionCode getVersionCode()
        versionName getVersionName()
    }
}
```

#### 6.4.2 自动生成变更日志
使用git-chglog工具生成变更日志：

```yaml
generate_changelog:
  stage: deploy
  script:
    - curl -sSL https://github.com/git-chglog/git-chglog/releases/download/v0.15.0/git-chglog_linux_amd64 -o git-chglog
    - chmod +x git-chglog
    - ./git-chglog -o CHANGELOG.md ${CI_COMMIT_TAG}
  artifacts:
    paths:
      - CHANGELOG.md
  only:
    - tags
```

## 第七章：高级主题与最佳实践
### 7.1 构建性能优化
#### 7.1.1 构建缓存策略

**Gradle 构建缓存**：

在 `gradle.properties` 中：

```properties
org.gradle.caching=true
```

在CI中配置远程缓存：

```groovy
buildCache {

    remote(HttpBuildCache) {

        url = 'https://your-cache-server/cache/'

        credentials {

            username = System.getenv('CACHE_USERNAME')

            password = System.getenv('CACHE_PASSWORD')

        }

    }

}
```

**CI 系统缓存**：

- Jenkins：使用 workspace/@libs 共享库；
- GitLab CI：优化 cache 配置。

#### 7.1.2 并行构建
```properties
# gradle.properties
org.gradle.parallel=true
org.gradle.workers.max=4
```

在 CI 中根据机器配置调整 `--max-workers` 参数。

#### 7.1.3 增量构建
确保任务正确配置输入输出以实现增量构建：

```groovy
task processTemplates(type: Copy) {
    inputs.property("version", project.version)
    from 'src/templates'
    into 'build/processed'
    expand(version: project.version)
}
```

### 7.2 安全性最佳实践

**凭据管理**：

- 永远不要将敏感信息提交到代码仓库；
- 使用 CI 系统的秘密管理功能；
- 限制秘密的访问权限。

**依赖验证**：

```groovy
dependencyVerification {

    verify = [

        'androidx.appcompat:appcompat:1.3.0': 'sha256:abcdef...',

        // 其他依赖的校验和

    ]

}
```

**最小权限原则**：

- CI Runner/Agent 使用专用用户；
- 限制网络访问；
- 定期轮换凭据。

### 7.3 监控与告警
#### 7.3.1 构建监控

**Jenkins**：

- 安装 Prometheus 插件；
- 配置构建健康指标。

**GitLab CI**：

- 使用内置的 CI/CD 分析；
- 集成 Prometheus 监控。

#### 7.3.2 告警配置

**构建失败告警**：

- Jenkins：安装 Email Extension Plugin 配置邮件通知；
- GitLab CI：配置 Webhook 或集成 Slack/Microsoft Teams。

**性能下降告警**：

- 监控构建时间；
- 设置阈值触发告警。

### 7.4 灾难恢复

**备份策略**：

- 定期备份 Jenkins/GitLab 配置；
- 备份关键构建产物。

**恢复流程**：

- 文档化恢复步骤；
- 定期测试恢复流程。

**高可用性**：

- 考虑 Jenkins 主从架构；
- GitLab Runner 自动扩展。

## 第八章：案例研究与实战示例
### 8.1 中小型团队CI/CD配置
#### 8.1.1 Jenkins Pipeline示例
```groovy
pipeline {
    agent any
    
    environment {
        ANDROID_HOME = '/opt/android-sdk'
        PATH = "${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
    }
    
    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }
        
        stage('Build') {
            steps {
                sh './gradlew assembleDebug'
            }
        }
        
        stage('Unit Test') {
            steps {
                sh './gradlew testDebugUnitTest jacocoTestReport'
            }
            post {
                always {
                    junit 'app/build/test-results/testDebugUnitTest/**/*.xml'
                    jacoco execPattern: 'app/build/jacoco/testDebugUnitTest.exec'
                }
            }
        }
        
        stage('Lint') {
            steps {
                sh './gradlew lintDebug'
            }
            post {
                always {
                    archiveArtifacts artifacts: 'app/build/reports/lint/lint-report.html', allowEmptyArchive: true
                }
            }
        }
        
        stage('Deploy to Internal') {
            when {
                branch 'develop'
            }
            steps {
                sshagent(['web-server-credentials']) {
                    sh """
                    scp app/build/outputs/apk/debug/app-debug.apk \
                        user@webserver:/var/www/downloads/app-${BUILD_NUMBER}.apk
                    """
                }
            }
        }
    }
    
    post {
        always {
            archiveArtifacts 'app/build/outputs/apk/debug/*.apk'
            cleanWs()
        }
        failure {
            emailext body: '构建失败: ${BUILD_URL}', subject: '构建失败: ${JOB_NAME}', to: 'team@example.com'
        }
    }
}
```

#### 8.1.2 GitLab CI配置示例
```yaml
image: android-ci-image:latest

variables:
  ANDROID_COMPILE_SDK: "30"
  ANDROID_BUILD_TOOLS: "30.0.3"
  GRADLE_OPTS: "-Dorg.gradle.daemon=false"

stages:
  - build
  - test
  - deploy

cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .gradle/
    - app/build/

build:
  stage: build
  script:
    - ./gradlew assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
    expire_in: 1 week

unit_test:
  stage: test
  script:
    - ./gradlew testDebugUnitTest jacocoTestReport
  artifacts:
    paths:
      - app/build/reports/tests/
      - app/build/reports/jacoco/
    reports:
      junit: app/build/test-results/testDebugUnitTest/**/*.xml
    expire_in: 1 week

lint:
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true

deploy_internal:
  stage: deploy
  script:
    - apt-get update && apt-get install -y openssh-client
    - mkdir -p ~/.ssh
    - echo "$SSH_PRIVATE_KEY" > ~/.ssh/id_rsa
    - chmod 600 ~/.ssh/id_rsa
    - scp app/build/outputs/apk/debug/app-debug.apk user@webserver:/var/www/downloads/app-${CI_COMMIT_SHORT_SHA}.apk
  only:
    - develop
```

### 8.2 大型企业级配置
#### 8.2.1 Jenkins多分支Pipeline
```groovy
def androidBuildTools = '30.0.3'
def androidCompileSdk = '30'

pipeline {
    agent {
        label 'android-agent'
    }
    
    options {
        timeout(time: 30, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '10'))
        disableConcurrentBuilds()
    }
    
    environment {
        ANDROID_HOME = '/opt/android-sdk'
        PATH = "${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
    }
    
    stages {
        stage('Checkout & Setup') {
            steps {
                checkout scm
                sh 'git submodule update --init --recursive'
            }
        }
        
        stage('Build') {
            parallel {
                stage('Debug Build') {
                    steps {
                        sh "./gradlew assembleDebug"
                    }
                }
                stage('Release Build') {
                    when {
                        anyOf {
                            branch 'main'
                            branch 'release/*'
                        }
                    }
                    steps {
                        withCredentials([...]) {
                            sh "./gradlew assembleRelease"
                        }
                    }
                }
            }
        }
        
        stage('Static Analysis') {
            parallel {
                stage('Lint') {
                    steps {
                        sh "./gradlew lintDebug"
                    }
                    post {
                        always {
                            archiveArtifacts artifacts: 'app/build/reports/lint/lint-report.html', allowEmptyArchive: true
                        }
                    }
                }
                stage('Checkstyle') {
                    steps {
                        sh "./gradlew checkstyle"
                    }
                    post {
                        always {
                            archiveArtifacts artifacts: 'app/build/reports/checkstyle/checkstyle.html', allowEmptyArchive: true
                        }
                    }
                }
                stage('SonarQube') {
                    steps {
                        withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                            sh "./gradlew sonarqube -Dsonar.login=${SONAR_TOKEN}"
                        }
                    }
                }
            }
        }
        
        stage('Test') {
            parallel {
                stage('Unit Test') {
                    steps {
                        sh "./gradlew testDebugUnitTest jacocoTestReport"
                    }
                    post {
                        always {
                            junit 'app/build/test-results/testDebugUnitTest/**/*.xml'
                            jacoco execPattern: 'app/build/jacoco/testDebugUnitTest.exec'
                        }
                    }
                }
                stage('Instrumented Test') {
                    steps {
                        androidEmulator(
                            androidHome: env.ANDROID_HOME,
                            avdName: 'ci-emulator',
                            osVersion: '30',
                            arch: 'x86_64',
                            forceAvdCreation: false,
                            wipeData: false,
                            snapshot: false,
                            deleteAfterBuild: false
                        ) {
                            sh "./gradlew connectedDebugAndroidTest"
                        }
                    }
                    post {
                        always {
                            junit 'app/build/outputs/androidTest-results/connected/**/*.xml'
                        }
                    }
                }
            }
        }
        
        stage('Deploy') {
            when {
                anyOf {
                    branch 'main'
                    branch 'release/*'
                    tag '*'
                }
            }
            steps {
                script {
                    if (env.BRANCH_NAME == 'main' || env.BRANCH_NAME.startsWith('release/')) {
                        // 部署到测试环境
                        firebaseAppDistribution(
                            appId: '1:1234567890:android:abcdef1234567890',
                            serviceCredentialsFile: 'firebase-key.json',
                            artifactPath: 'app/build/outputs/apk/release/app-release.apk',
                            groups: 'qa-team,dev-team'
                        )
                    }
                    
                    if (env.TAG_NAME != null) {
                        // 部署到Google Play
                        googlePlayUploader(
                            applicationId: 'com.your.package',
                            credentialsId: 'google-play-credentials',
                            apkFiles: 'app/build/outputs/apk/release/app-release.apk',
                            trackName: 'production',
                            rolloutPercentage: '10'
                        )
                    }
                }
            }
        }
    }
    
    post {
        always {
            archiveArtifacts artifacts: 'app/build/outputs/**/*.apk', allowEmptyArchive: true
            cleanWs()
        }
        failure {
            slackSend color: 'danger', message: "构建失败: ${env.JOB_NAME} #${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)"
        }
        success {
            slackSend color: 'good', message: "构建成功: ${env.JOB_NAME} #${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)"
        }
    }
}
```

#### 8.2.2 GitLab CI企业级配置
```yaml
include:
  - template: 'Workflows/MergeRequest-Pipelines.gitlab-ci.yml'

variables:
  ANDROID_COMPILE_SDK: "30"
  ANDROID_BUILD_TOOLS: "30.0.3"
  GRADLE_OPTS: "-Dorg.gradle.daemon=false -Dorg.gradle.workers.max=4 -Dorg.gradle.caching=true"
  DOCKER_DRIVER: overlay2
  DOCKER_TLS_CERTDIR: ""

stages:
  - build
  - test
  - security
  - deploy

.default_android:
  image: $CI_REGISTRY/android-ci-image:latest
  tags:
    - android
    - docker
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - .gradle/
      - app/build/
    policy: pull-push
  before_script:
    - export GRADLE_USER_HOME=$(pwd)/.gradle
    - chmod +x gradlew

build:debug:
  extends: .default_android
  stage: build
  script:
    - ./gradlew assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
    expire_in: 1 week

build:release:
  extends: .default_android
  stage: build
  script:
    - ./gradlew assembleRelease
  artifacts:
    paths:
      - app/build/outputs/apk/release/*.apk
    expire_in: 1 week
  only:
    - main
    - release/*
    - tags

unit_test:
  extends: .default_android
  stage: test
  script:
    - ./gradlew testDebugUnitTest jacocoTestReport
  artifacts:
    paths:
      - app/build/reports/tests/
      - app/build/reports/jacoco/
    reports:
      junit: app/build/test-results/testDebugUnitTest/**/*.xml
    expire_in: 1 week

instrumented_test:
  extends: .default_android
  stage: test
  services:
    - docker:dind
  script:
    - docker run --detach --privileged --name emulator --publish 5554:5554 --publish 5555:5555
      -e ADBKEY="$(cat ~/.android/adbkey)" android-emulator:30
    - adb wait-for-device
    - ./gradlew connectedDebugAndroidTest
  artifacts:
    paths:
      - app/build/reports/androidTests/connected/
    reports:
      junit: app/build/outputs/androidTest-results/connected/**/*.xml
    expire_in: 1 week

lint:
  extends: .default_android
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true

sonarqube:
  extends: .default_android
  stage: security
  variables:
    SONAR_USER_HOME: "${CI_PROJECT_DIR}/.sonar"
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
  only:
    - main
    - merge_requests

dependency_scan:
  stage: security
  image: owasp/dependency-check:latest
  script:
    - dependency-check.sh --scan "$CI_PROJECT_DIR" --project "$CI_PROJECT_NAME"
      --out "$CI_PROJECT_DIR" --format ALL --disableAssembly
  artifacts:
    paths:
      - dependency-check-report.*
    expire_in: 1 week
  allow_failure: true

deploy:firebase:
  extends: .default_android
  stage: deploy
  script:
    - curl -sSL https://firebase.tools | bash
    - echo "$FIREBASE_KEY" > /tmp/firebase-key.json
    - firebase appdistribution:distribute app/build/outputs/apk/release/app-release.apk
        --app 1:1234567890:android:abcdef1234567890
        --groups "qa-team"
        --token $(cat /tmp/firebase-key.json | jq -r '.client_email')
  only:
    - main
    - release/*

deploy:play_store:
  extends: .default_android
  stage: deploy
  script:
    - mkdir -p ~/.android
    - echo "$GOOGLE_PLAY_KEY" > ~/.android/google-play-key.json
    - ./gradlew publishReleaseBundle
  only:
    - tags
```

## 第九章：常见问题与解决方案
### 9.1 构建失败常见原因

**依赖下载失败**：

解决方案：配置镜像仓库或使用离线仓库。

在 `build.gradle` 中：

```groovy
repositories {

    maven { url 'https://maven.aliyun.com/repository/public' }

    google()

    jcenter()

}
```

**内存不足**：

解决方案：增加 Gradle 内存。

在 `gradle.properties` 中：

```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m
```

**签名配置错误**：

解决方案：验证签名配置和凭据。

- 确保密钥文件路径正确；
- 验证密码和别名。

### 9.2 测试相关问题

**模拟器启动失败**：

解决方案：确保 KVM 已启用。

检查命令示例：

```bash
grep -c vmx /proc/cpuinfo
```

**测试不稳定**：

解决方案：增加重试机制。

在 `build.gradle` 中：

```groovy
android {

    testOptions {

        execution 'ANDROIDX_TEST_ORCHESTRATOR'

        animationsDisabled = true

        unitTests {

            all {

                testLogging {

                    events "failed"

                    exceptionFormat "full"

                }

                maxParallelForks = Runtime.runtime.availableProcessors() / 2

                forkEvery = 100

                retry {

                    maxRetries = 3

                    maxFailures = 20

                }

            }

        }

    }

}
```

### 9.3 性能优化问题

**构建速度慢**：

解决方案：

- 启用构建缓存；
- 配置适当的并行度；
- 使用增量构建。

**缓存无效**：

解决方案：验证缓存策略。

- 确保缓存键包含所有影响构建的输入。

### 9.4 安全相关问题

**敏感信息泄露**：

解决方案：

- 使用 CI 系统的秘密管理；
- 避免在日志中打印敏感信息；
- 定期轮换凭据。

**依赖安全漏洞**：

解决方案：

- 使用 OWASP Dependency-Check；
- 定期更新依赖。

## 第十章：未来趋势与总结
### 10.1 CI/CD 的未来趋势

**更快的构建技术**：

- 增量构建改进；
- 分布式构建缓存；
- 云原生构建系统。

**更智能的测试**：

- 基于变更的测试选择；
- 机器学习优化测试套件。

**更紧密的 DevOps 集成**：

- 基础设施即代码；
- 自动化的金丝雀发布；
- 特性标志管理。

**安全左移**：

- 更早的安全扫描；
- 自动化的合规检查。

### 10.2 工具演进方向

**Jenkins**：

- Jenkins X 专注于云原生 CI/CD；
- 配置即代码的进一步推广；
- 更好的 Kubernetes 集成。

**GitLab CI**：

- 更强大的 Auto DevOps 功能；
- 更精细的权限控制；
- 改进的测试报告可视化。

### 10.3 总结与建议

建立高效的 Android CI/CD 流程需要综合考虑团队规模、项目复杂度和工具偏好。以下是一些关键建议：

- **从小开始，逐步扩展**：从基本的构建和测试开始，逐步添加更复杂的流程；
- **监控和优化**：持续监控构建性能，识别瓶颈；
- **文档化流程**：确保团队成员理解 CI/CD 流程；
- **安全第一**：从一开始就考虑安全性，避免后期重构；
- **保持更新**：定期评估和采用新的工具和实践。

无论选择 Jenkins 还是 GitLab CI，关键在于建立一套可靠、可重复的自动化流程，让团队能够专注于开发高质量的应用，而不是手动构建和部署的繁琐工作。

