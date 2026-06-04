---
title: "Android CI/CD with Jenkins and GitLab CI: Multibranch Pipeline"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part7
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part7
excerpt: "Part 7 of the Android CI/CD with Jenkins and GitLab CI series: Jenkins multibranch Pipeline."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 7
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Multibranch Pipeline"
  description: "Build an enterprise-ready Jenkins multibranch Pipeline for Android with parallel builds, analysis, tests, Firebase, Google Play, and Slack."
---
> This is part 7 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered advanced topics and best practices.

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

---

> In the next article, we will cover enterprise GitLab CI configuration. Stay tuned for the rest of the series.

**Series index: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"**

1. Preface
2. Basic build configuration
3. Automated test integration
4. Code quality checks
5. Automated release and deployment
6. Advanced topics and best practices
7. **Jenkins multibranch Pipeline** (this article)
8. Enterprise GitLab CI configuration
