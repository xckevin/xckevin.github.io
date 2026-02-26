---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（7）：2.1 Jenkins多分支Pipeline"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 7/8 篇：2.1 Jenkins多分支Pipeline"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 7
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（7）：2.1 Jenkins多分支Pipeline"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 7/8 篇：2.1 Jenkins多分支Pipeline"
---
# Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（7）：2.1 Jenkins多分支Pipeline

> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 7 篇，共 8 篇。在上一篇中，我们探讨了「高级主题与最佳实践」的相关内容。

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

---

> 下一篇我们将探讨「2.2 GitLab CI企业级配置」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. 自动化测试集成
4. 代码质量检查
5. 自动化发布与部署
6. 高级主题与最佳实践
7. **2.1 Jenkins多分支Pipeline**（本文）
8. 2.2 GitLab CI企业级配置
