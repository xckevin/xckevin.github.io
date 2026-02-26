---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（1）：前言"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 1/8 篇：前言"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 1
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（1）：前言"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 1/8 篇：前言"
---
# Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（1）：前言

> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 1 篇，共 8 篇。

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

---

> 下一篇我们将探讨「基础构建配置」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. **前言**（本文）
2. 基础构建配置
3. 自动化测试集成
4. 代码质量检查
5. 自动化发布与部署
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
