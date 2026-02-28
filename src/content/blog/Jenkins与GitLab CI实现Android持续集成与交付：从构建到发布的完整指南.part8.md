---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（8）：2.2 GitLab CI企业级配置"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 8/8 篇：2.2 GitLab CI企业级配置"
publishDate: 2025-09-06
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 8
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（8）：2.2 GitLab CI企业级配置"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 8/8 篇：2.2 GitLab CI企业级配置"
---
> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 8 篇，共 8 篇。在上一篇中，我们探讨了「2.1 Jenkins多分支Pipeline」的相关内容。

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

---

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. 自动化测试集成
4. 代码质量检查
5. 自动化发布与部署
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. **2.2 GitLab CI企业级配置**（本文）
