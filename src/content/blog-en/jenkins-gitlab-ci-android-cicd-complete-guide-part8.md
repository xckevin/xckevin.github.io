---
title: "Android CI/CD with Jenkins and GitLab CI: Enterprise GitLab CI"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part8
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part8
excerpt: "Part 8 of the Android CI/CD with Jenkins and GitLab CI series: enterprise GitLab CI configuration."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 8
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Enterprise GitLab CI"
  description: "Design enterprise GitLab CI for Android with reusable jobs, testing, security scanning, deployment, troubleshooting, and future trends."
---
> This is part 8 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered Jenkins multibranch Pipeline.

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

## Chapter 9: Common issues and solutions
### 9.1 Common causes of build failures

**Dependency download failures**:

Solution: configure mirror repositories or use an offline repository.

In `build.gradle`:

```groovy
repositories {

    maven { url 'https://maven.aliyun.com/repository/public' }

    google()

    jcenter()

}
```

**Insufficient memory**:

Solution: increase Gradle memory.

In `gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m
```

**Incorrect signing configuration**:

Solution: verify the signing configuration and credentials.

- Make sure the key file path is correct.
- Verify the password and alias.

### 9.2 Test-related issues

**Emulator startup failure**:

Solution: make sure KVM is enabled.

Example check command:

```bash
grep -c vmx /proc/cpuinfo
```

**Flaky tests**:

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

### 9.3 Performance optimization issues

**Slow builds**:

Solution:

- Enable the build cache.
- Configure suitable parallelism.
- Use incremental builds.

**Invalid cache**:

Solution: verify the cache strategy.

- Make sure cache keys include every input that affects the build.

### 9.4 Security-related issues

**Sensitive information leakage**:

Solution:

- Use the CI system's secret management.
- Avoid printing sensitive information in logs.
- Rotate credentials regularly.

**Dependency security vulnerabilities**:

Solution:

- Use OWASP Dependency-Check.
- Update dependencies regularly.

## Chapter 10: Future trends and summary
### 10.1 Future CI/CD trends

**Faster build technologies**:

- Improved incremental builds.
- Distributed build caches.
- Cloud-native build systems.

**Smarter testing**:

- Change-based test selection.
- Machine-learning-optimized test suites.

**Tighter DevOps integration**:

- Infrastructure as code.
- Automated canary releases.
- Feature flag management.

**Shift-left security**:

- Earlier security scanning.
- Automated compliance checks.

### 10.2 Tool evolution

**Jenkins**:

- Jenkins X focuses on cloud-native CI/CD.
- Broader adoption of configuration as code.
- Better Kubernetes integration.

**GitLab CI**:

- More powerful Auto DevOps capabilities.
- More granular permission control.
- Improved test report visualization.

### 10.3 Summary and recommendations

Building an efficient Android CI/CD process requires balancing team size, project complexity, and tool preferences. Here are several key recommendations:

- **Start small and expand gradually**: Begin with basic build and test workflows, then add more complex processes over time.
- **Monitor and optimize**: Continuously monitor build performance and identify bottlenecks.
- **Document the process**: Make sure team members understand the CI/CD workflow.
- **Security first**: Account for security from the beginning to avoid later rework.
- **Stay current**: Regularly evaluate and adopt new tools and practices.

Whether you choose Jenkins or GitLab CI, the key is to build a reliable and repeatable automation process so the team can focus on developing high-quality apps instead of spending time on manual builds and deployments.

---

**Series index: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"**

1. Preface
2. Basic build configuration
3. Automated test integration
4. Code quality checks
5. Automated release and deployment
6. Advanced topics and best practices
7. Jenkins multibranch Pipeline
8. **Enterprise GitLab CI configuration** (this article)
