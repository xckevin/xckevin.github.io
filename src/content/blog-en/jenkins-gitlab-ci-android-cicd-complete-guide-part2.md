---
title: "Android CI/CD with Jenkins and GitLab CI: Basic Build Setup"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part2
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part2
excerpt: "Part 2 of the Android CI/CD with Jenkins and GitLab CI series: basic build setup."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 2
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Basic Build Setup"
  description: "Set up basic Android builds in Jenkins and GitLab CI with Gradle tasks, source control, triggers, artifacts, caching, and multi-module builds."
---
> This is part 2 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered the introduction.

## Chapter 3: Basic build setup
### 3.1 Reviewing the Android project structure

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

- On the Jenkins dashboard, click "New Item."
- Enter a project name, such as "Android-CI."
- Select "Freestyle project," then click "OK."

#### 3.2.2 Configure source control

In the "Source Code Management" section:

- Select "Git."
- Enter the Repository URL, such as a GitHub or GitLab repository URL.
- Configure credentials as needed.
- Specify the branch, such as `*/main` or `*/develop`.

#### 3.2.3 Configure build triggers
In the "Build Triggers" section, choose the trigger that fits your workflow:

- **Poll SCM**: periodically checks for code changes.
  - Schedule: `H/5 * * * *`, which checks every five minutes.
- **GitHub/GitLab hook**: triggers when code is pushed. This requires additional webhook configuration.

#### 3.2.4 Configure the build environment

- Select "Provide Configuration files" if needed.
- Select "Use secret text(s) or file(s)" if secure credentials are needed.

In the "Build Environment" section, you can:

- Select "Delete workspace before build starts" to clean the workspace.
- Select "Add timestamps to the Console Output" to timestamp logs.

#### 3.2.5 Configure build steps

In the "Build" section, click "Add build step."

Choose "Invoke Gradle script" and configure it as follows:

- Gradle version: `gradle-8.4`, the version configured earlier.
- Tasks: `clean assembleDebug`, or `assembleRelease`.
- Select "Make gradlew executable" for the first build.

#### 3.2.6 Configure post-build actions
In the "Post-build Actions" section, click "Add post-build action":

1. Select "Archive the artifacts."
   - Files to archive: `app/build/outputs/apk/debug/*.apk`.
2. Add "Publish JUnit test result."
   - Test report XMLs: `app/build/test-results/**/*.xml`.
3. Add "Record JaCoCo coverage report."
   - Configure the coverage report path.

#### 3.2.7 Save and run the build

Click "Save," then click "Build Now" to run the first build.

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

- **stages**: defines the stages in the build workflow.
- **variables**: sets environment variables so values are easier to maintain and change.
- **cache**: caches Gradle files and build outputs to speed up later builds.
- **build job**:
  - `stage`: places the job in the build stage.
  - `tags`: specifies the runner tags used to run this job.
  - `script`: lists the commands to execute.
  - `artifacts`: saves build outputs so later stages can use them.

#### 3.3.3 Advanced cache configuration
To use caching more effectively, you can refine the configuration:

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
For multi-module projects, you can extend the build configuration:

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
# Parallel builds
org.gradle.parallel=true
# Enable the build cache
org.gradle.caching=true
# Enable the configuration cache (Gradle 6.6+)
org.gradle.unsafe.configuration-cache=true
# JVM memory configuration
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
# Disable the Gradle daemon in CI
org.gradle.daemon=false
```

For Jenkins, add these parameters to the build step:

```plain
tasks: clean assembleDebug
switches: --build-cache --parallel --max-workers=4
```

For GitLab CI, add them to the script:

```yaml
script:
  - ./gradlew assembleDebug --build-cache --parallel --max-workers=4
```

---

> In the next article, we will cover automated test integration. Stay tuned for the rest of the series.

**Series: Android CI/CD with Jenkins and GitLab CI: From Build to Release**

1. Introduction
2. **Basic build setup** (this article)
3. Automated test integration
4. Code quality checks
5. Automated release and deployment
6. Advanced topics and best practices
7. 2.1 Jenkins multibranch Pipeline
8. 2.2 Enterprise GitLab CI configuration
