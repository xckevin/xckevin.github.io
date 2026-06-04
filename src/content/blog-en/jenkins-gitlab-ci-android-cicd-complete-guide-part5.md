---
title: "Android CI/CD with Jenkins and GitLab CI: Release Automation"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part5
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part5
excerpt: "Part 5 of the Android CI/CD with Jenkins and GitLab CI series: automated release and deployment."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 5
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Release Automation"
  description: "Automate Android release builds, signing secrets, internal distribution, Firebase App Distribution, Google Play publishing, versioning, and changelogs."
---
> This is part 5 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered code quality checks.

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
**Jenkins**:

Add credentials in "Manage Jenkins" > "Manage Credentials":

- Kind: Secret text.
- Scope: Global.
- Secret: `[your_store_password]`.
- ID: `STORE_PASSWORD`.

Use credentials in the build configuration:

```groovy
withCredentials([string(credentialsId: 'STORE_PASSWORD', variable: 'STORE_PASSWORD'),

                string(credentialsId: 'KEY_ALIAS', variable: 'KEY_ALIAS'),

                string(credentialsId: 'KEY_PASSWORD', variable: 'KEY_PASSWORD')]) {

    sh './gradlew assembleRelease'

}
```

**GitLab CI**:

Add variables in "Settings" > "CI/CD" > "Variables":

- `STORE_PASSWORD`.
- `KEY_ALIAS`.
- `KEY_PASSWORD`.
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

#### 6.2.2 Release to Firebase App Distribution
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

### 6.3 Release to Google Play
#### 6.3.1 Prepare Google Play API access

- Create a service account in Google Play Console.
- Download the JSON key file.
- Configure the key in the CI system.

#### 6.3.2 Jenkins configuration

- Install the "Google Play Android Publisher" plugin.
- Add credentials:
  - Kind: Google Service Account from private key.
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

#### 6.4.2 Generate changelogs automatically
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

---

> In the next article, we will cover advanced topics and best practices. Stay tuned for the rest of the series.

**Series: Android CI/CD with Jenkins and GitLab CI: From Build to Release**

1. Introduction
2. Basic build setup
3. Automated test integration
4. Code quality checks
5. **Automated release and deployment** (this article)
6. Advanced topics and best practices
7. 2.1 Jenkins multibranch Pipeline
8. 2.2 Enterprise GitLab CI configuration
