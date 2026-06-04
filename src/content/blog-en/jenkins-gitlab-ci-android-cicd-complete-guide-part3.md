---
title: "Android CI/CD with Jenkins and GitLab CI: Automated Tests"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part3
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part3
excerpt: "Part 3 of the Android CI/CD with Jenkins and GitLab CI series: automated test integration."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 3
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Automated Tests"
  description: "Integrate Android unit tests, instrumented tests, Firebase Test Lab, JUnit reports, JaCoCo coverage, and HTML reports into Jenkins and GitLab CI."
---
> This is part 3 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered basic build setup.

## Chapter 4: Automated test integration
### 4.1 Overview of Android testing

Android app testing is usually divided into three levels:

- **Unit tests**: test individual classes or methods and run on the JVM.
  - Location: `module/src/test/java/`.
  - Frameworks: JUnit, Mockito, Robolectric, and others.
- **Instrumented tests**: run on an Android device or emulator.
  - Location: `module/src/androidTest/java/`.
  - Frameworks: AndroidX Test, Espresso, UI Automator, and others.
- **UI tests**: test user interface interactions.
  - These are usually implemented as part of instrumented tests.

### 4.2 Configure unit tests
#### 4.2.1 Jenkins configuration
Add a test task to the build step:

```plain
tasks: clean testDebugUnitTest
```

Add a post-build action to collect test results:

- Add "Publish JUnit test result."
- Test report XMLs: `app/build/test-results/testDebugUnitTest/**/*.xml`.

Add a code coverage report:

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
Instrumented tests need to run on an Android device or emulator. In CI, you can use:

- **Physical devices**: real devices connected to the CI server.
- **Emulators**: Android emulators started on the CI server.
- **Firebase Test Lab**: Google's cloud testing service.
- **Third-party services**: BrowserStack, Sauce Labs, and similar services.

#### 4.3.1 Run instrumented tests with an emulator
**Jenkins configuration**:

- Install the Android Emulator Plugin.
- In the build environment, select "Android Emulator."
- Configure the emulator:
  - Android SDK: select the configured Android SDK.
  - AVD name: `ci-emulator`.
  - System image: for example, `system-images;android-30;google_apis;x86_64`.
  - Screen density: 240.
  - Screen resolution: 1080x1920.
  - Device locale: en_US.
  - Device language: en.
  - Other options: adjust as needed.
- Add a build step to run the tests:

```plain
tasks: connectedDebugAndroidTest
```

Collect test results:

JUnit report path: `app/build/outputs/androidTest-results/connected/**/*.xml`

Coverage report: if JaCoCo is configured, the path is `app/build/reports/coverage/androidTest/debug/`

**GitLab CI configuration**:

Run the emulator with Docker-in-Docker or privileged mode:

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
For broader test coverage, use Firebase Test Lab:

- Set up a Firebase project and enable Test Lab.
- Create a service account and download the JSON key file.
- Configure the key in CI.

**Jenkins configuration**:

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

**GitLab CI configuration**:

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

**JUnit reports**:

- Install the JUnit Plugin.
- In "Post-build Actions," add "Publish JUnit test result."
- Specify the test result path, such as `**/test-results/**/*.xml`.

**JaCoCo coverage reports**:

- Install the JaCoCo Plugin.
- In "Post-build Actions," add "Record JaCoCo coverage report."
- Configure include and exclude patterns.

**HTML reports**:

- Install the HTML Publisher Plugin.
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

---

> In the next article, we will cover code quality checks. Stay tuned for the rest of the series.

**Series: Android CI/CD with Jenkins and GitLab CI: From Build to Release**

1. Introduction
2. Basic build setup
3. **Automated test integration** (this article)
4. Code quality checks
5. Automated release and deployment
6. Advanced topics and best practices
7. 2.1 Jenkins multibranch Pipeline
8. 2.2 Enterprise GitLab CI configuration
