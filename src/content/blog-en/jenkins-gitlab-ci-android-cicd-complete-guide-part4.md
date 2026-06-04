---
title: "Android CI/CD with Jenkins and GitLab CI: Code Quality Checks"
lang: en
translationKey: jenkins-gitlab-ci-android-cicd-complete-guide-part4
slug: jenkins-gitlab-ci-android-cicd-complete-guide-part4
excerpt: "Part 4 of the Android CI/CD with Jenkins and GitLab CI series: code quality checks."
publishDate: '2025-09-06'
displayInBlog: false
tags:
- "Android"
- "CI/CD"
- "Jenkins"
- "DevOps"
series:
  name: "Android CI/CD with Jenkins and GitLab CI: From Build to Release"
  part: 4
  total: 8
seo:
  title: "Android CI/CD with Jenkins and GitLab CI: Code Quality Checks"
  description: "Run Android Lint, Checkstyle, SonarQube, quality gates, and build-blocking checks in Jenkins and GitLab CI for stronger Android releases."
---
> This is part 4 of the eight-part series "Android CI/CD with Jenkins and GitLab CI: From Build to Release." In the previous article, we covered automated test integration.

## Chapter 5: Code quality checks
### 5.1 Static code analysis tools
Common static code analysis tools in Android development include:

- **Android Lint**: the official static analysis tool, used to check for potential issues and optimization suggestions.
- **Checkstyle**: code style checks.
- **PMD**: detects common programming defects.
- **FindBugs/SpotBugs**: finds bug patterns in code.
- **Detekt** for Kotlin projects: a Kotlin static analysis tool.
- **SonarQube**: a comprehensive code quality platform.

### 5.2 Configure Android Lint
#### 5.2.1 Gradle configuration

Add lint configuration to `build.gradle`:

```groovy
android {
    lintOptions {
        abortOnError true
        warningsAsErrors true
        checkAllWarnings true
        htmlReport true
        htmlOutput file("${buildDir}/reports/lint/lint-report.html")
        xmlReport true
        xmlOutput file("${buildDir}/reports/lint/lint-report.xml")
        sarifReport true
        sarifOutput file("${buildDir}/reports/lint/lint-report.sarif")
    }
}
```

#### 5.2.2 Jenkins integration
Add a build step:

```plain
tasks: lintDebug
```

Add a post-build action to publish the report:

HTML Publisher: `app/build/reports/lint/lint-report.html`

If the build should fail when Lint checks fail, add a script:

```groovy
def lintTask = tasks.getByPath(':app:lintDebug')

if (lintTask.outputFile.text.contains("errors")) {

    error("Lint checks found errors")

}
```

#### 5.2.3 GitLab CI integration
```yaml
lint:
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true  # Set to true or false as needed
```

### 5.3 Configure Checkstyle
#### 5.3.1 Add the Checkstyle plugin

In `build.gradle`:

```groovy
plugins {
    id 'checkstyle'
}

checkstyle {
    toolVersion '8.42'
    configFile file("${project.rootDir}/config/checkstyle/checkstyle.xml")
    configProperties = ['checkstyle.cache.file': "${buildDir}/checkstyle.cache"]
    ignoreFailures false
    showViolations true
}

task checkstyle(type: Checkstyle) {
    source 'src'
    include '**/*.java'
    exclude '**/gen/**', '**/test/**', '**/androidTest/**'
    classpath = files()
}
```

#### 5.3.2 Example configuration file
`config/checkstyle/checkstyle.xml`:

```xml
<?xml version="1.0"?>
<!DOCTYPE module PUBLIC
        "-//Checkstyle//DTD Checkstyle Configuration 1.3//EN"
        "https://checkstyle.org/dtds/configuration_1_3.dtd">
<module name="Checker">
    <property name="charset" value="UTF-8"/>
    <property name="severity" value="error"/>
    
    <module name="FileTabCharacter"/>
    <module name="TreeWalker">
        <module name="JavadocMethod"/>
        <module name="MethodName"/>
        <module name="ParameterNumber">
            <property name="max" value="5"/>
        </module>
    </module>
</module>
```

#### 5.3.3 CI integration
**Jenkins**:

Add a build step:

```plain
tasks: checkstyle
```

Publish the HTML report:

Path: `app/build/reports/checkstyle/checkstyle.html`

**GitLab CI**:

```yaml
checkstyle:
  stage: test
  script:
    - ./gradlew checkstyle
  artifacts:
    paths:
      - app/build/reports/checkstyle/
    expire_in: 1 week
```

### 5.4 Integrate SonarQube
#### 5.4.1 Install the SonarQube server

- Download SonarQube Community Edition: [https://www.sonarqube.org/downloads/](https://www.sonarqube.org/downloads/).
- Extract it and run:

```bash
./bin/linux-x86-64/sonar.sh start
```

Visit `http://localhost:9000`. The default account is admin/admin.

#### 5.4.2 Gradle configuration

In `build.gradle`:

```groovy
plugins {
    id "org.sonarqube" version "3.3"
}

sonarqube {
    properties {
        property "sonar.projectKey", "your-project-key"
        property "sonar.host.url", "http://your-sonar-server:9000"
        property "sonar.login", project.hasProperty('sonarToken') ? sonarToken : ""
        property "sonar.android.lint.report", "build/reports/lint/lint-report.xml"
        property "sonar.java.checkstyle.reportPaths", "build/reports/checkstyle/checkstyle.xml"
        property "sonar.coverage.jacoco.xmlReportPaths", "build/reports/jacoco/jacocoTestReport/jacocoTestReport.xml"
    }
}
```

#### 5.4.3 CI integration
**Jenkins**:

Install the SonarQube Scanner plugin.

Configure the SonarQube server in "Manage Jenkins" > "Configure System."

Add a build step:

```plain
tasks: sonarqube

-Dsonar.login=$SONAR_TOKEN
```

**GitLab CI**:

```yaml
sonarqube:
  stage: test
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
  only:
    - master
    - develop
```

### 5.5 Quality gates and build blocking
Configure quality gates so the build is blocked when code quality does not meet the standard:

#### 5.5.1 Jenkins configuration
```groovy
stage('Quality Gate') {
    steps {
        script {
            def qualityGate = waitForQualityGate()
            if (qualityGate.status != 'OK') {
                error "Quality gate failed: ${qualityGate.status}"
            }
        }
    }
}
```

#### 5.5.2 GitLab CI configuration
```yaml
quality_gate:
  stage: test
  script:
    - ./gradlew sonarqube -Dsonar.login=$SONAR_TOKEN
    - >
      curl --fail --user $SONAR_TOKEN:
      "$SONAR_HOST_URL/api/qualitygates/project_status?projectKey=$SONAR_PROJECT_KEY"
      | grep -q '"status":"OK"'
  allow_failure: false
```

---

> In the next article, we will cover automated release and deployment. Stay tuned for the rest of the series.

**Series: Android CI/CD with Jenkins and GitLab CI: From Build to Release**

1. Introduction
2. Basic build setup
3. Automated test integration
4. **Code quality checks** (this article)
5. Automated release and deployment
6. Advanced topics and best practices
7. 2.1 Jenkins multibranch Pipeline
8. 2.2 Enterprise GitLab CI configuration
