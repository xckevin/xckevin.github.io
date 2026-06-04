---
title: "Android CI/CD with Jenkins and GitLab CI: Complete Guide (1): Introduction"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part1
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part1
excerpt: "Part 1 of the Android CI/CD with Jenkins and GitLab CI series: introduction, tool selection, and environment setup."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: A Complete Guide from Build to Release"
  part: 1
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Guide Part 1"
  description: "Start an Android CI/CD series with Jenkins and GitLab CI, covering core concepts, tool choice, Jenkins setup, GitLab Runner, and Android SDK setup."
  pageType: article
---

> This is part 1 of the 8-part series "Android CI/CD with Jenkins and GitLab CI: A Complete Guide from Build to Release."

![](../../assets/jenkins%E4%B8%8Egitlab-ci%E5%AE%9E%E7%8E%B0android%E6%8C%81%E7%BB%AD%E9%9B%86%E6%88%90%E4%B8%8E%E4%BA%A4%E4%BB%98%E4%BB%8E%E6%9E%84%E5%BB%BA%E5%88%B0%E5%8F%91%E5%B8%83%E7%9A%84%E5%AE%8C%E6%95%B4%E6%8C%87%E5%8D%97-1.png)

## Introduction

In today's fast-moving mobile development environment, continuous integration (CI) and continuous delivery (CD) have become essential parts of modern software development. For Android teams, building an efficient and reliable automated system for building, testing, and releasing apps can significantly improve development efficiency, reduce human error, and shorten product delivery cycles.

This article explores how to implement CI/CD for Android projects with two mainstream tools: Jenkins and GitLab CI. We will start with the basic concepts, then move gradually into advanced configuration and optimization techniques, covering the full process from build automation, test execution, code quality checks, and report generation to app release.

Whether you are new to CI/CD or an experienced developer looking to optimize an existing workflow, this guide provides practical guidance and deeper insight. Through detailed configuration examples, code snippets, and best practices, it will help you build a robust Android CI/CD pipeline.

## Chapter 1: Continuous integration fundamentals and tool selection

### 1.1 Core concepts of continuous integration

Continuous integration is a software development practice that requires developers to merge code changes frequently into a shared mainline branch. Each integration is verified by automated builds and tests so integration errors can be found as early as possible.

**Core value of continuous integration:**

- **Fast feedback:** developers receive build and test results immediately after committing code.
- **Early issue detection:** integration problems and defects are found early in the development cycle.
- **Lower integration risk:** long-lived branches and complex merge conflicts are avoided.
- **Deployable software:** the team always maintains a deployable version of the software.

For Android development, continuous integration is especially important because:

- Android apps must be built into APK or AAB files before they can run.
- Testing is needed across multiple devices and API levels.
- The release process is complex and includes signing, channel packaging, and related steps.

### 1.2 Comparing Jenkins and GitLab CI

When choosing a CI/CD tool, Jenkins and GitLab CI are two of the most popular options. The table below compares them in detail:

| Feature | Jenkins | GitLab CI |
| --- | --- | --- |
| **Architecture** | Controller-agent architecture; supports distributed execution | Runner-based; supports distributed execution |
| **Installation and maintenance** | Requires an independent server; higher maintenance cost | Integrated with GitLab; simpler maintenance |
| **Configuration style** | Web UI or Groovy DSL | YAML file (`.gitlab-ci.yml`) |
| **Extensibility** | Rich plugin ecosystem; highly extensible | More focused feature set; moderate extensibility |
| **Integration** | Integrates with many tools but requires configuration | Deep GitLab integration; other tools require configuration |
| **Learning curve** | Steeper | Gentler |
| **Community support** | Very active, with extensive documentation | Active, with good documentation |
| **Best fit** | Complex projects that need heavy customization | GitLab users who want a simple CI/CD solution |

### 1.3 Tool selection recommendations

Based on the comparison above, here are practical recommendations.

**Choose Jenkins when:**

- The project is very complex and needs a highly customized build workflow.
- The team already uses Jenkins and is familiar with it.
- You need to integrate with many different tools and services.
- The project is not hosted on GitLab.

**Choose GitLab CI when:**

- The code is already hosted on GitLab.
- You want simple configuration and low maintenance cost.
- The project is relatively standard and does not need heavy customization.
- The team is small and resources are limited.

In real projects, the two tools can also be combined to take advantage of each. For example, GitLab CI can handle the initial build and test steps after code submission, while Jenkins handles more complex release workflows and later-stage testing.

## Chapter 2: Environment preparation and basic configuration

### 2.1 Hardware and software requirements

Before configuring a CI/CD workflow, make sure the environment is ready. These are the basic requirements for Android CI/CD:

**Hardware requirements:**

- **CPU:** at least 4 cores; 8 cores or more recommended, especially when running multiple builds in parallel.
- **Memory:** at least 8 GB; 16 GB recommended, and large projects may need 32 GB.
- **Storage:** at least 100 GB SSD, because Android builds produce many cache files.
- **Network:** stable, high-speed network connectivity for downloading dependencies and uploading build artifacts.

**Software requirements:**

- **Operating system:** Linux, preferably Ubuntu LTS or CentOS; macOS and Windows are also possible.
- **Java Development Kit (JDK):** Android development requires JDK 8 or 11; newer projects are generally better served by JDK 17. AdoptOpenJDK is recommended.
- **Android SDK:** latest stable version, including the required platform tools and build tools.
- **Docker** (optional): used to containerize the build environment and ensure consistency.
- **Version control system:** Git.

### 2.2 Jenkins installation and initial configuration

#### 2.2.1 Jenkins installation

Install Jenkins on Ubuntu with the following steps:

```bash
# 1. Add the Jenkins repository key
wget -q -O - https://pkg.jenkins.io/debian/jenkins.io.key | sudo apt-key add -

# 2. Add the Jenkins repository to the source list
sudo sh -c 'echo deb http://pkg.jenkins.io/debian-stable binary/ > /etc/apt/sources.list.d/jenkins.list'

# 3. Update the package index
sudo apt-get update

# 4. Install Jenkins
sudo apt-get install jenkins

# 5. Start the Jenkins service
sudo systemctl start jenkins

# 6. Enable Jenkins on boot
sudo systemctl enable jenkins
```

After installation, Jenkins runs on port 8080 by default. Open `http://your-server-ip:8080` in a browser and complete the initial setup wizard.

#### 2.2.2 Initial security configuration

Get the initial administrator password from the log:

```bash
sudo cat /var/lib/jenkins/secrets/initialAdminPassword
```

After entering the password in the web UI, choose "Install suggested plugins" to install the recommended plugins.

- Create the first administrator user.
- Configure the instance URL; the default is usually fine.

#### 2.2.3 Install required plugins

For Android CI/CD, install these key plugins:

- **Android Emulator Plugin:** manages Android emulators.
- **Git Plugin:** provides Git integration.
- **Gradle Plugin:** supports Gradle builds.
- **Pipeline:** defines build pipelines.
- **HTML Publisher:** publishes HTML reports.
- **JUnit:** processes JUnit test results.
- **JaCoCo:** supports code coverage.
- **SonarQube Scanner** (optional): analyzes code quality.
- **Google Play Android Publisher** (optional): publishes apps to Google Play.

Plugin installation steps:

1. Open "Manage Jenkins" > "Manage Plugins".
2. Select the "Available" tab.
3. Search for the plugins above and select them.
4. Click "Install without restart" or "Download now and install after restart."

#### 2.2.4 Configure global tools

In "Manage Jenkins" > "Global Tool Configuration", configure:

- **JDK:**
  - Name: `jdk17`
  - `JAVA_HOME`: `/usr/lib/jvm/java-17-openjdk-amd64`
- **Git:**
  - Name: `Default`
  - Path to Git executable: `git`
- **Gradle:**
  - Name: `gradle-8.4`
  - Select "Install automatically"
  - Version: `8.4`
  - Leave other options at their defaults

### 2.3 GitLab CI Runner installation and configuration

#### 2.3.1 Install GitLab Runner

Install GitLab Runner on Ubuntu:

```bash
# 1. Add the official repository
curl -L https://packages.gitlab.com/install/repositories/runner/gitlab-runner/script.deb.sh | sudo bash

# 2. Install the latest GitLab Runner
sudo apt-get install gitlab-runner

# 3. Verify the installation
gitlab-runner --version
```

#### 2.3.2 Register the Runner

In the GitLab project, go to "Settings" > "CI/CD" > "Runners".

Find the URL and token in the "Set up a specific Runner manually" section.

Run the registration command on the server:

```bash
sudo gitlab-runner register
```

Enter the following when prompted:

GitLab instance URL: `https://gitlab.xxx-host.com/`

Registration token: get it from the GitLab UI.

Description: `android-runner`

Tags: `android, docker` (optional)

Executor: `docker` (recommended) or `shell`

If you choose the Docker executor, also specify a default Docker image, such as `docker:stable`.

#### 2.3.3 Configure the Runner

Edit the Runner configuration file, usually `/etc/gitlab-runner/config.toml`, and make sure it contains the following configuration:

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

#### 2.3.4 Install Docker (if using the Docker executor)

```bash
# 1. Install required dependencies
sudo apt-get install apt-transport-https ca-certificates curl gnupg-agent software-properties-common

# 2. Add Docker's official GPG key
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -

# 3. Add the Docker repository
sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable"

# 4. Update the package index and install Docker
sudo apt-get update
sudo apt-get install docker-ce docker-ce-cli containerd.io

# 5. Add the current user to the docker group to avoid using sudo every time
sudo usermod -aG docker $USER
sudo usermod -aG docker gitlab-runner

# 6. Restart the Docker service
sudo systemctl restart docker
```

### 2.4 Android SDK configuration

Whether you use Jenkins or GitLab CI, the Android SDK must be configured correctly.

#### 2.4.1 Install Android command-line tools

```bash
# 1. Create the Android SDK directory
mkdir -p ~/android-sdk/cmdline-tools
cd ~/android-sdk/cmdline-tools

# 2. Download command-line tools; the version may change, so check the latest release
wget https://dl.google.com/android/repository/commandlinetools-linux-6858069_latest.zip
unzip commandlinetools-linux-6858069_latest.zip
mv cmdline-tools latest

# 3. Add environment variables
echo 'export ANDROID_HOME=$HOME/android-sdk' >> ~/.bashrc
echo 'export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools' >> ~/.bashrc
source ~/.bashrc

# 4. Accept licenses
yes | sdkmanager --licenses

# 5. Install basic tools and platforms
sdkmanager "platform-tools" "platforms;android-30" "build-tools;30.0.3"
```

#### 2.4.2 Configure Android SDK in Jenkins

Open "Manage Jenkins" > "Global Tool Configuration":

- Find the "Android SDK" section.
- Click "Add Android SDK".
- Configure it as follows:
  - Name: `android-sdk-latest`
  - Clear "Install automatically"
  - Android SDK home: `/home/jenkins/android-sdk` (adjust according to the actual path)

#### 2.4.3 Configure Android SDK in GitLab Runner

If you use the Docker executor, create a custom Docker image that includes the Android SDK:

```dockerfile
# Dockerfile.android
FROM openjdk:17-jdk

# Install basic tools
RUN apt-get update && apt-get install -y \
    git \
    wget \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV ANDROID_HOME /opt/android-sdk
ENV PATH ${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools

# Download and install Android SDK
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools && \
    cd ${ANDROID_HOME}/cmdline-tools && \
    wget https://dl.google.com/android/repository/commandlinetools-linux-6858069_latest.zip -O cmdline-tools.zip && \
    unzip cmdline-tools.zip && \
    mv cmdline-tools latest && \
    rm cmdline-tools.zip

# Accept licenses and install components
RUN yes | sdkmanager --licenses && \
    sdkmanager "platform-tools" "platforms;android-30" "build-tools;30.0.3"

WORKDIR /app
```

Build and push the image:

```bash
docker build -t android-ci-image -f Dockerfile.android .
docker tag android-ci-image your-registry/android-ci-image:latest
docker push your-registry/android-ci-image:latest
```

Then use this image in `.gitlab-ci.yml`:

```yaml
image: your-registry/android-ci-image:latest
```

---

> In the next article, we will cover basic build configuration. Stay tuned.

**Series contents: "Android CI/CD with Jenkins and GitLab CI: A Complete Guide from Build to Release"**

1. **Introduction** (this article)
2. Basic build configuration
3. Automated test integration
4. Code quality checks
5. Automated release and deployment
6. Advanced topics and best practices
7. 2.1 Jenkins multibranch Pipeline
8. 2.2 Enterprise GitLab CI configuration
