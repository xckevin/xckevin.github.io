---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（4）：代码质量检查"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 4/8 篇：代码质量检查"
publishDate: 2025-09-06
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 4
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（4）：代码质量检查"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 4/8 篇：代码质量检查"
---
> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 4 篇，共 8 篇。在上一篇中，我们探讨了「自动化测试集成」的相关内容。

## 第五章：代码质量检查
### 5.1 静态代码分析工具
Android 开发中常用的静态代码分析工具：

- **Android Lint**：官方静态分析工具，检查潜在问题和优化建议；
- **Checkstyle**：代码风格检查；
- **PMD**：检测常见编程缺陷；
- **FindBugs/SpotBugs**：查找代码中的 bug 模式；
- **Detekt**（Kotlin 项目）：Kotlin 静态分析工具；
- **SonarQube**：综合代码质量平台。

### 5.2 配置Android Lint
#### 5.2.1 Gradle 配置

在 `build.gradle` 中添加 lint 配置：

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

#### 5.2.2 Jenkins集成
添加构建步骤：

```plain
tasks: lintDebug
```

添加后构建操作发布报告：

HTML Publisher：app/build/reports/lint/lint-report.html

若需要在 Lint 检查失败时使构建失败，可以添加脚本：

```groovy
def lintTask = tasks.getByPath(':app:lintDebug')

if (lintTask.outputFile.text.contains("errors")) {

    error("Lint检查发现错误")

}
```

#### 5.2.3 GitLab CI集成
```yaml
lint:
  stage: test
  script:
    - ./gradlew lintDebug
  artifacts:
    paths:
      - app/build/reports/lint/
    expire_in: 1 week
  allow_failure: true  # 根据需要设置为 true 或 false
```

### 5.3 配置Checkstyle
#### 5.3.1 添加 Checkstyle 插件

在 `build.gradle` 中：

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

#### 5.3.2 配置文件示例
config/checkstyle/checkstyle.xml:

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

#### 5.3.3 CI集成
**Jenkins**:

添加构建步骤：

```plain
tasks: checkstyle
```

发布HTML报告：

路径：app/build/reports/checkstyle/checkstyle.html

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

### 5.4 集成SonarQube
#### 5.4.1 SonarQube 服务器安装

- 下载 SonarQube 社区版：[https://www.sonarqube.org/downloads/](https://www.sonarqube.org/downloads/)；
- 解压并运行：

```bash
./bin/linux-x86-64/sonar.sh start
```

访问 `http://localhost:9000`，默认账号为 admin/admin。

#### 5.4.2 Gradle 配置

在 `build.gradle` 中：

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

#### 5.4.3 CI集成
**Jenkins**:

安装SonarQube Scanner插件

在"Manage Jenkins" > "Configure System"中配置SonarQube服务器

添加构建步骤：

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

### 5.5 质量门禁与构建阻断
配置质量门禁，当代码质量不达标时阻断构建：

#### 5.5.1 Jenkins配置
```groovy
stage('Quality Gate') {
    steps {
        script {
            def qualityGate = waitForQualityGate()
            if (qualityGate.status != 'OK') {
                error "质量门禁未通过: ${qualityGate.status}"
            }
        }
    }
}
```

#### 5.5.2 GitLab CI配置
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

> 下一篇我们将探讨「自动化发布与部署」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. 基础构建配置
3. 自动化测试集成
4. **代码质量检查**（本文）
5. 自动化发布与部署
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
