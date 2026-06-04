---
title: "Android CI/CD with Jenkins and GitLab CI: Advanced Practices"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part6
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part6
excerpt: "Part 6 of the Android CI/CD with Jenkins and GitLab CI series: advanced topics and best practices."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 6
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Advanced Practices"
  description: "Optimize Android CI/CD with build caching, parallel and incremental builds, security practices, monitoring, recovery, and practical pipelines."
---
> This is part 6 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered automated release and deployment.

## Chapter 7: Advanced topics and best practices
### 7.1 Build performance optimization
#### 7.1.1 Build cache strategy

**Gradle build cache**:

In `gradle.properties`:

```properties
org.gradle.caching=true
```

Configure a remote cache in CI:

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

**CI system cache**:

- Jenkins: use `workspace/@libs` shared libraries.
- GitLab CI: optimize the `cache` configuration.

#### 7.1.2 Parallel builds
```properties
# gradle.properties
org.gradle.parallel=true
org.gradle.workers.max=4
```

Tune the `--max-workers` parameter in CI based on the machine configuration.

#### 7.1.3 Incremental builds
Make sure tasks correctly declare inputs and outputs so incremental builds can work:

```groovy
task processTemplates(type: Copy) {
    inputs.property("version", project.version)
    from 'src/templates'
    into 'build/processed'
    expand(version: project.version)
}
```

### 7.2 Security best practices

**Credential management**:

- Never commit sensitive information to the repository.
- Use the CI system's secret management features.
- Restrict access to secrets.

**Dependency verification**:

```groovy
dependencyVerification {

    verify = [

        'androidx.appcompat:appcompat:1.3.0': 'sha256:abcdef...',

        // Checksums for other dependencies

    ]

}
```

**Principle of least privilege**:

- Run CI runners/agents with dedicated users.
- Restrict network access.
- Rotate credentials regularly.

### 7.3 Monitoring and alerts
#### 7.3.1 Build monitoring

**Jenkins**:

- Install the Prometheus plugin.
- Configure build health metrics.

**GitLab CI**:

- Use the built-in CI/CD analytics.
- Integrate Prometheus monitoring.

#### 7.3.2 Alert configuration

**Build failure alerts**:

- Jenkins: install the Email Extension Plugin and configure email notifications.
- GitLab CI: configure webhooks or integrate Slack/Microsoft Teams.

**Performance regression alerts**:

- Monitor build duration.
- Set thresholds that trigger alerts.

### 7.4 Disaster recovery

**Backup strategy**:

- Back up Jenkins/GitLab configuration regularly.
- Back up critical build artifacts.

**Recovery process**:

- Document recovery steps.
- Test the recovery process regularly.

**High availability**:

- Consider a Jenkins controller/agent architecture.
- Use GitLab Runner autoscaling.

## Chapter 8: Case studies and practical examples

### 8.1 CI/CD configuration for small and midsize teams
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

---

> In the next article, we will cover Jenkins multibranch Pipeline. Stay tuned for the rest of the series.

**Series index: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"**

1. Preface
2. Basic build configuration
3. Automated test integration
4. Code quality checks
5. Automated release and deployment
6. **Advanced topics and best practices** (this article)
7. Jenkins multibranch Pipeline
8. Enterprise GitLab CI configuration
