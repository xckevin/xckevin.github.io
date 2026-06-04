---
title: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide
slug: jenkins-gitlab-ci-android-cicd-complete-guide
excerpt: "A complete Android CI/CD guide covering Jenkins, GitLab CI, automated builds, tests, signing, quality gates, release, deployment, and best practices."
publishDate: '2025-09-06'
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Full Guide"
  description: "Build a complete Android CI/CD pipeline with Jenkins and GitLab CI, from environment setup and testing to signing, release, quality gates, and deployment."
  pageType: article
---

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

## Chapter 3: Basic build configuration

### 3.1 Android project structure review

Before configuring CI/CD, it is important to understand the standard Android project structure. A typical Android project contains these key parts:

```plain
my-android-app/
├── app/                # Main module
│   ├── build.gradle    # Module-level build configuration
│   ├── src/
│   │   ├── main/       # Main source code
│   │   ├── test/       # Unit tests
│   │   └── androidTest # Instrumented tests
├── build.gradle        # Project-level build configuration
├── settings.gradle     # Project settings
├── gradle.properties  # Gradle properties
└── gradlew             # Gradle wrapper script
```

### 3.2 Basic Jenkins build configuration

#### 3.2.1 Create a freestyle project

- In the Jenkins dashboard, click "New Item".
- Enter a project name, such as `Android-CI`.
- Select "Freestyle project" and click "OK."

#### 3.2.2 Configure source code management

In the "Source Code Management" section:

- Select "Git".
- Enter the Repository URL, such as a GitHub or GitLab repository URL.
- Configure credentials as needed.
- Specify the branch, such as `*/main` or `*/develop`.

#### 3.2.3 Configure build triggers

In the "Build Triggers" section, select suitable triggers:

- **Poll SCM:** periodically checks for code changes.
  - Schedule: `H/5 * * * *` (check every 5 minutes).
- **GitHub/GitLab hook:** triggers when code is pushed; additional webhook configuration is required.

#### 3.2.4 Configure the build environment

- Select "Provide Configuration files" if needed.
- Select "Use secret text(s) or file(s)" if secure credentials are needed.

In the "Build Environment" section, you can:

- Select "Delete workspace before build starts" to clean the workspace.
- Select "Add timestamps to the Console Output" to add timestamps to logs.

#### 3.2.5 Configure build steps

In the "Build" section, click "Add build step".

Select "Invoke Gradle script" and configure:

- Gradle version: `gradle-8.4` (configured earlier).
- Tasks: `clean assembleDebug` or `assembleRelease`.
- Select "Make gradlew executable" for the first build.

#### 3.2.6 Configure post-build actions

In the "Post-build Actions" section, click "Add post-build action":

1. Select "Archive the artifacts".
   - Files to archive: `app/build/outputs/apk/debug/*.apk`.
2. Add "Publish JUnit test result".
   - Test report XMLs: `app/build/test-results/**/*.xml`.
3. Add "Record JaCoCo coverage report".
   - Configure the coverage report paths.

#### 3.2.7 Save and run the build

Click "Save", then click "Build Now" to run the first build.

### 3.3 Basic GitLab CI configuration

GitLab CI defines the build workflow in a `.gitlab-ci.yml` file at the project root.

#### 3.3.1 Create a basic configuration file

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

# Cache configuration
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

#### 3.3.2 Configuration notes

- **stages:** defines the phases of the build workflow.
- **variables:** sets environment variables for easier maintenance and changes.
- **cache:** caches Gradle files and build outputs to speed up later builds.
- **build job:**
  - `stage`: belongs to the build stage.
  - `tags`: specifies the runner tags used to run this job.
  - `script`: commands to execute.
  - `artifacts`: saves build outputs for later stages.

#### 3.3.3 Advanced cache configuration

To use caching more effectively, optimize the configuration:

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

#### 3.3.4 Multi-module project configuration

For multi-module projects, extend the build configuration:

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

### 3.4 Gradle build optimization

To speed up CI builds, add the following configuration to `gradle.properties`:

```properties
# Parallel build
org.gradle.parallel=true
# Enable build cache
org.gradle.caching=true
# Enable configuration cache (Gradle 6.6+)
org.gradle.unsafe.configuration-cache=true
# JVM memory configuration
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
# Disable the Gradle daemon in CI environments
org.gradle.daemon=false
```

For Jenkins, add these parameters in the build step:

```plain
tasks: clean assembleDebug
switches: --build-cache --parallel --max-workers=4
```

For GitLab CI, add them to the script:

```yaml
script:
  - ./gradlew assembleDebug --build-cache --parallel --max-workers=4
```

## Chapter 4: Automated test integration

### 4.1 Android testing overview

Android app testing is usually divided into three layers:

- **Unit tests:** test individual classes or methods and run on the JVM.
  - Location: `module/src/test/java/`.
  - Frameworks: JUnit, Mockito, Robolectric, and others.
- **Instrumented tests:** tests that run on Android devices or emulators.
  - Location: `module/src/androidTest/java/`.
  - Frameworks: AndroidX Test, Espresso, UI Automator, and others.
- **UI tests:** test user interface interactions.
  - Usually implemented as part of instrumented tests.

### 4.2 Configure unit tests

#### 4.2.1 Jenkins configuration

Add the test task to the build step:

```plain
tasks: clean testDebugUnitTest
```

Add a post-build action to collect test results:

- Add "Publish JUnit test result".
- Test report XMLs: `app/build/test-results/testDebugUnitTest/**/*.xml`.

Add a code coverage report.

Make sure JaCoCo is configured in `build.gradle`:

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

Add the build step:

```plain
tasks: jacocoTestReport
```

Add the "Record JaCoCo coverage report" post-build action.

#### 4.2.2 GitLab CI configuration

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

### 4.3 Configure instrumented tests

Instrumented tests must run on an Android device or emulator. In a CI environment, you can use:

- **Physical devices:** real devices connected to the CI server.
- **Emulators:** Android emulators started on the CI server.
- **Firebase Test Lab:** a cloud testing service.
- **Third-party services:** BrowserStack, Sauce Labs, and similar services.

#### 4.3.1 Run instrumented tests with an emulator

**Jenkins configuration:**

- Install Android Emulator Plugin.
- Select "Android Emulator" in the build environment.
- Configure the emulator:
  - Android SDK: select the configured Android SDK.
  - AVD name: `ci-emulator`.
  - System image: for example, `system-images;android-30;google_apis;x86_64`.
  - Screen density: 240.
  - Screen resolution: 1080x1920.
  - Device locale: `en_US`.
  - Device language: `en`.
  - Other options: adjust as needed.
- Add a build step to run tests:

```plain
tasks: connectedDebugAndroidTest
```

Collect test results:

JUnit report path: `app/build/outputs/androidTest-results/connected/**/*.xml`

Coverage report: if JaCoCo is configured, the path is `app/build/reports/coverage/androidTest/debug/`

**GitLab CI configuration:**

Use Docker-in-Docker or privileged mode to run the emulator:

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
    # Start the emulator container
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

#### 4.3.2 Use Firebase Test Lab

For more comprehensive testing, use Firebase Test Lab:

- Set up a Firebase project and enable Test Lab.
- Create a service account and download the JSON key file.
- Configure the key in CI.

**Jenkins configuration:**

- Add the Firebase key to Jenkins as a secret file.

Add a build step:

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

**GitLab CI configuration:**

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

### 4.4 Test reports and visualization

#### 4.4.1 Jenkins test reports

**JUnit report:**

- Install JUnit Plugin.
- Add "Publish JUnit test result" in "Post-build Actions".
- Specify the test result path, such as `**/test-results/**/*.xml`.

**JaCoCo coverage report:**

- Install JaCoCo Plugin.
- Add "Record JaCoCo coverage report" in "Post-build Actions".
- Configure include and exclude patterns.

**HTML report:**

- Install HTML Publisher Plugin.
- Add the "Publish HTML reports" post-build action.
- Specify the HTML report directory, such as `app/build/reports/`.

#### 4.4.2 GitLab test reports

GitLab automatically parses JUnit-formatted test reports:

```yaml
artifacts:
  reports:
    junit: app/build/test-results/**/*.xml
    cobertura: app/build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml
```

Coverage visualization:

```yaml
coverage: '/Total.*?([0-9]{1,3})%/'
```

#### 4.4.3 Custom HTML reports

Create a custom test report:

Generate the HTML report in the build script.

Save it as an artifact.

```yaml
generate_report:
  stage: test
  script:
    - ./gradlew generateTestReport
  artifacts:
    paths:
      - app/build/reports/custom-test-report.html
```

## Chapter 5: Code quality checks

### 5.1 Static code analysis tools

Common static analysis tools in Android development:

- **Android Lint:** the official static analysis tool, used to find potential issues and optimization suggestions.
- **Checkstyle:** code style checks.
- **PMD:** detects common programming defects.
- **FindBugs/SpotBugs:** finds bug patterns in code.
- **Detekt** (Kotlin projects): a Kotlin static analysis tool.
- **SonarQube:** a comprehensive code quality platform.

### 5.2 Configure Android Lint

#### 5.2.1 Gradle configuration

Add lint configuration in `build.gradle`:

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

#### 5.2.2 Jenkins integration

Add a build step:

```plain
tasks: lintDebug
```

Add a post-build action to publish reports:

HTML Publisher: `app/build/reports/lint/lint-report.html`

If the build should fail when Lint finds issues, add a script:

```groovy
def lintTask = tasks.getByPath(':app:lintDebug')

if (lintTask.outputFile.text.contains("errors")) {

    error("Lint found errors")

}
```

#### 5.2.3 GitLab CI integration

```yaml
lint:
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true  # Set to true or false as needed
```

### 5.3 Configure Checkstyle

#### 5.3.1 Add the Checkstyle plugin

In `build.gradle`:

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

#### 5.3.2 Example configuration file

`config/checkstyle/checkstyle.xml`:

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

#### 5.3.3 CI integration

**Jenkins:**

Add a build step:

```plain
tasks: checkstyle
```

Publish the HTML report:

Path: `app/build/reports/checkstyle/checkstyle.html`

**GitLab CI:**

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

### 5.4 Integrate SonarQube

#### 5.4.1 Install SonarQube server

- Download SonarQube Community Edition: [https://www.sonarqube.org/downloads/](https://www.sonarqube.org/downloads/).
- Extract it and run:

```bash
./bin/linux-x86-64/sonar.sh start
```

Open `http://localhost:9000`. The default account is `admin/admin`.

#### 5.4.2 Gradle configuration

In `build.gradle`:

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

#### 5.4.3 CI integration

**Jenkins:**

Install the SonarQube Scanner plugin.

Configure the SonarQube server in "Manage Jenkins" > "Configure System".

Add a build step:

```plain
tasks: sonarqube

-Dsonar.login=$SONAR_TOKEN
```

**GitLab CI:**

```yaml
sonarqube:
  stage: test
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
  only:
    - master
    - develop
```

### 5.5 Quality gates and build blocking

Configure quality gates so builds are blocked when code quality does not meet the threshold:

#### 5.5.1 Jenkins configuration

```groovy
stage('Quality Gate') {
    steps {
        script {
            def qualityGate = waitForQualityGate()
            if (qualityGate.status != 'OK') {
                error "Quality gate failed: ${qualityGate.status}"
            }
        }
    }
}
```

#### 5.5.2 GitLab CI configuration

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

## Chapter 6: Automated release and deployment

### 6.1 Build variants and signing configuration

#### 6.1.1 Configure build types and product flavors

In `app/build.gradle`:

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

#### 6.1.2 Store signing information securely

**Jenkins:**

Add credentials in "Manage Jenkins" > "Manage Credentials":

- Kind: Secret text
- Scope: Global
- Secret: `[your_store_password]`
- ID: `STORE_PASSWORD`

Use credentials in the build configuration:

```groovy
withCredentials([string(credentialsId: 'STORE_PASSWORD', variable: 'STORE_PASSWORD'),

                string(credentialsId: 'KEY_ALIAS', variable: 'KEY_ALIAS'),

                string(credentialsId: 'KEY_PASSWORD', variable: 'KEY_PASSWORD')]) {

    sh './gradlew assembleRelease'

}
```

**GitLab CI:**

Add variables in "Settings" > "CI/CD" > "Variables":

- `STORE_PASSWORD`
- `KEY_ALIAS`
- `KEY_PASSWORD`
- Select "Mask variable" and "Protect variable."

In `.gitlab-ci.yml`:

```yaml
build_release:

  stage: build

  script:

    - ./gradlew assembleRelease

  only:

    - tags
```

### 6.2 Release to internal channels

#### 6.2.1 Release to an internal web server

**Jenkins:**

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

**GitLab CI:**

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

#### 6.2.2 Release to Firebase App Distribution

**Jenkins:**

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

**GitLab CI:**

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

### 6.3 Release to Google Play

#### 6.3.1 Prepare Google Play API access

- Create a service account in Google Play Console.
- Download the JSON key file.
- Configure the key in the CI system.

#### 6.3.2 Jenkins configuration

- Install the "Google Play Android Publisher" plugin.
- Add credentials:
  - Kind: Google Service Account from private key
  - Upload the JSON key file.
- Add a step to the build configuration:

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

#### 6.3.3 GitLab CI configuration

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

Configure the publishing plugin in `build.gradle`:

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

### 6.4 Version management and changelogs

#### 6.4.1 Automatic version number management

In `build.gradle`:

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

#### 6.4.2 Automatically generate changelogs

Use `git-chglog` to generate changelogs:

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

## Chapter 7: Advanced topics and best practices

### 7.1 Build performance optimization

#### 7.1.1 Build cache strategy

**Gradle build cache:**

In `gradle.properties`:

```properties
org.gradle.caching=true
```

Configure remote cache in CI:

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

**CI system cache:**

- Jenkins: use `workspace/@libs` shared libraries.
- GitLab CI: optimize cache configuration.

#### 7.1.2 Parallel builds

```properties
# gradle.properties
org.gradle.parallel=true
org.gradle.workers.max=4
```

Adjust the `--max-workers` parameter in CI according to the machine configuration.

#### 7.1.3 Incremental builds

Make sure tasks configure inputs and outputs correctly so incremental builds can work:

```groovy
task processTemplates(type: Copy) {
    inputs.property("version", project.version)
    from 'src/templates'
    into 'build/processed'
    expand(version: project.version)
}
```

### 7.2 Security best practices

**Credential management:**

- Never commit sensitive information to the code repository.
- Use the CI system's secret-management features.
- Restrict access to secrets.

**Dependency verification:**

```groovy
dependencyVerification {

    verify = [

        'androidx.appcompat:appcompat:1.3.0': 'sha256:abcdef...',

        // Checksums for other dependencies

    ]

}
```

**Principle of least privilege:**

- Run CI Runner/Agent under a dedicated user.
- Restrict network access.
- Rotate credentials regularly.

### 7.3 Monitoring and alerts

#### 7.3.1 Build monitoring

**Jenkins:**

- Install the Prometheus plugin.
- Configure build health metrics.

**GitLab CI:**

- Use built-in CI/CD analytics.
- Integrate Prometheus monitoring.

#### 7.3.2 Alert configuration

**Build failure alerts:**

- Jenkins: install Email Extension Plugin and configure email notifications.
- GitLab CI: configure webhooks or integrate Slack/Microsoft Teams.

**Performance degradation alerts:**

- Monitor build duration.
- Set thresholds to trigger alerts.

### 7.4 Disaster recovery

**Backup strategy:**

- Back up Jenkins/GitLab configuration regularly.
- Back up critical build artifacts.

**Recovery process:**

- Document recovery steps.
- Test the recovery process regularly.

**High availability:**

- Consider a Jenkins controller-agent architecture.
- Use GitLab Runner autoscaling.

## Chapter 8: Case studies and practical examples

### 8.1 CI/CD configuration for small and medium teams

#### 8.1.1 Jenkins Pipeline example

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
            emailext body: 'Build failed: ${BUILD_URL}', subject: 'Build failed: ${JOB_NAME}', to: 'team@example.com'
        }
    }
}
```

#### 8.1.2 GitLab CI configuration example

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

### 8.2 Large enterprise configuration

#### 8.2.1 Jenkins multibranch Pipeline

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
                        // Deploy to the test environment
                        firebaseAppDistribution(
                            appId: '1:1234567890:android:abcdef1234567890',
                            serviceCredentialsFile: 'firebase-key.json',
                            artifactPath: 'app/build/outputs/apk/release/app-release.apk',
                            groups: 'qa-team,dev-team'
                        )
                    }
                    
                    if (env.TAG_NAME != null) {
                        // Deploy to Google Play
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
            slackSend color: 'danger', message: "Build failed: ${env.JOB_NAME} #${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)"
        }
        success {
            slackSend color: 'good', message: "Build succeeded: ${env.JOB_NAME} #${env.BUILD_NUMBER} (<${env.BUILD_URL}|Open>)"
        }
    }
}
```

#### 8.2.2 Enterprise GitLab CI configuration

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

## Chapter 9: Common problems and solutions

### 9.1 Common causes of build failure

**Dependency download failures:**

Solution: configure mirror repositories or use an offline repository.

In `build.gradle`:

```groovy
repositories {

    maven { url 'https://maven.aliyun.com/repository/public' }

    google()

    jcenter()

}
```

**Insufficient memory:**

Solution: increase Gradle memory.

In `gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m
```

**Incorrect signing configuration:**

Solution: verify signing configuration and credentials.

- Make sure the key file path is correct.
- Verify passwords and aliases.

### 9.2 Test-related problems

**Emulator startup failure:**

Solution: make sure KVM is enabled.

Example check command:

```bash
grep -c vmx /proc/cpuinfo
```

**Flaky tests:**

Solution: add a retry mechanism.

In `build.gradle`:

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

### 9.3 Performance optimization problems

**Slow builds:**

Solution:

- Enable build cache.
- Configure suitable parallelism.
- Use incremental builds.

**Ineffective cache:**

Solution: verify the cache strategy.

- Make sure the cache key includes all inputs that affect the build.

### 9.4 Security-related problems

**Sensitive information leakage:**

Solution:

- Use the CI system's secret management.
- Avoid printing sensitive information in logs.
- Rotate credentials regularly.

**Dependency security vulnerabilities:**

Solution:

- Use OWASP Dependency-Check.
- Update dependencies regularly.

## Chapter 10: Future trends and summary

### 10.1 Future trends in CI/CD

**Faster build technologies:**

- Better incremental builds.
- Distributed build cache.
- Cloud-native build systems.

**Smarter testing:**

- Change-based test selection.
- Machine-learning-optimized test suites.

**Tighter DevOps integration:**

- Infrastructure as code.
- Automated canary releases.
- Feature flag management.

**Shift-left security:**

- Earlier security scanning.
- Automated compliance checks.

### 10.2 Tool evolution

**Jenkins:**

- Jenkins X focuses on cloud-native CI/CD.
- Configuration as code continues to expand.
- Better Kubernetes integration.

**GitLab CI:**

- More powerful Auto DevOps capabilities.
- More granular permission control.
- Improved test report visualization.

### 10.3 Summary and recommendations

Building an efficient Android CI/CD workflow requires balancing team size, project complexity, and tool preference. Key recommendations include:

- **Start small and expand gradually:** begin with basic build and test workflows, then add more complex processes.
- **Monitor and optimize:** continuously monitor build performance and identify bottlenecks.
- **Document the process:** make sure team members understand the CI/CD workflow.
- **Put security first:** consider security from the beginning and avoid later rework.
- **Stay current:** regularly evaluate and adopt new tools and practices.

Whether you choose Jenkins or GitLab CI, the key is to establish a reliable, repeatable automated workflow so the team can focus on building high-quality apps instead of spending time on manual build and deployment work.

<!-- seo-internal-links -->

## Further reading

- [Back to topic: Mobile Engineering](/android-engineering/)
- [How to analyze a slow Android Gradle build](/en/blog/android-gradle-build-slow/)
- [Android testing in practice: JUnit, integration tests, Compose semantics, and CI](/en/blog/android-testing-junit-compose/)
<!-- /seo-internal-links -->
