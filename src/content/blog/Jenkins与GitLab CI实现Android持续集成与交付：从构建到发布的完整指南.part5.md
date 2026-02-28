---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（5）：自动化发布与部署"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 5/8 篇：自动化发布与部署"
publishDate: 2025-09-06
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 5
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（5）：自动化发布与部署"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 5/8 篇：自动化发布与部署"
---
> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 5 篇，共 8 篇。在上一篇中，我们探讨了「代码质量检查」的相关内容。

## 第六章：自动化发布与部署
### 6.1 构建变体与签名配置
#### 6.1.1 配置构建类型和产品风味
在app/build.gradle中：

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

#### 6.1.2 安全存储签名信息
**Jenkins**：

在「Manage Jenkins」>「Manage Credentials」中添加凭据：

- Kind：Secret text；
- Scope：Global；
- Secret：[your_store_password]；
- ID：STORE_PASSWORD。

在构建配置中使用凭据：

```groovy
withCredentials([string(credentialsId: 'STORE_PASSWORD', variable: 'STORE_PASSWORD'),

                string(credentialsId: 'KEY_ALIAS', variable: 'KEY_ALIAS'),

                string(credentialsId: 'KEY_PASSWORD', variable: 'KEY_PASSWORD')]) {

    sh './gradlew assembleRelease'

}
```

**GitLab CI**：

在「Settings」>「CI/CD」>「Variables」中添加变量：

- STORE_PASSWORD；
- KEY_ALIAS；
- KEY_PASSWORD；
- 勾选「Mask variable」和「Protect variable」。

在 `.gitlab-ci.yml` 中：

```yaml
build_release:

  stage: build

  script:

    - ./gradlew assembleRelease

  only:

    - tags
```

### 6.2 发布到内部渠道
#### 6.2.1 发布到内部Web服务器
**Jenkins**:

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

**GitLab CI**:

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

#### 6.2.2 发布到Firebase App Distribution
**Jenkins**:

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

**GitLab CI**:

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

### 6.3 发布到Google Play
#### 6.3.1 准备 Google Play API 访问

- 在 Google Play Console 创建服务账户；
- 下载 JSON 密钥文件；
- 在 CI 系统中配置密钥。

#### 6.3.2 Jenkins 配置

- 安装「Google Play Android Publisher」插件；
- 添加凭据：
  - Kind：Google Service Account from private key；
  - 上传 JSON 密钥文件。
- 在构建配置中添加步骤：

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

#### 6.3.3 GitLab CI配置
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

在 `build.gradle` 中配置发布插件：

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

### 6.4 版本管理与变更日志
#### 6.4.1 自动版本号管理

在 `build.gradle` 中：

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

#### 6.4.2 自动生成变更日志
使用git-chglog工具生成变更日志：

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

---

> 下一篇我们将探讨「高级主题与最佳实践」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. 自动化测试集成
4. 代码质量检查
5. **自动化发布与部署**（本文）
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
