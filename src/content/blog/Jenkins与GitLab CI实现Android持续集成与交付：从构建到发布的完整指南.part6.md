---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（6）：高级主题与最佳实践"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 6/8 篇：高级主题与最佳实践"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 6
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（6）：高级主题与最佳实践"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 6/8 篇：高级主题与最佳实践"
---
# Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（6）：高级主题与最佳实践

> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 6 篇，共 8 篇。在上一篇中，我们探讨了「自动化发布与部署」的相关内容。

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

---

> 下一篇我们将探讨「2.1 Jenkins多分支Pipeline」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. 自动化测试集成
4. 代码质量检查
5. 自动化发布与部署
6. **高级主题与最佳实践**（本文）
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
