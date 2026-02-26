---
title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（2）：基础构建配置"
excerpt: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 2/8 篇：基础构建配置"
publishDate: 2025-02-24
displayInBlog: false
tags:
  - Android
  - CI/CD
  - Jenkins
  - DevOps
series:
  name: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南"
  part: 2
  total: 8
seo:
  title: "Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（2）：基础构建配置"
  description: "「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列第 2/8 篇：基础构建配置"
---
# Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南（2）：基础构建配置

> 本文是「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列的第 2 篇，共 8 篇。在上一篇中，我们探讨了「前言」的相关内容。

## 第三章：基础构建配置
### 3.1 Android 项目结构回顾

在配置 CI/CD 之前，理解标准的 Android 项目结构很重要。典型的 Android 项目包含以下关键部分：

```plain
my-android-app/
├── app/                # 主模块
│   ├── build.gradle    # 模块级构建配置
│   ├── src/
│   │   ├── main/       # 主源代码
│   │   ├── test/       # 单元测试
│   │   └── androidTest # 仪器化测试
├── build.gradle        # 项目级构建配置
├── settings.gradle     # 项目设置
├── gradle.properties  # Gradle属性
└── gradlew             # Gradle包装器脚本
```

### 3.2 Jenkins基础构建配置
#### 3.2.1 创建自由风格项目

- 在 Jenkins 仪表板，点击「New Item」；
- 输入项目名称，如「Android-CI」；
- 选择「Freestyle project」，点击「OK」。

#### 3.2.2 配置源代码管理

在「Source Code Management」部分：

- 选择「Git」；
- 输入 Repository URL（如 GitHub 或 GitLab 仓库 URL）；
- 根据需要配置凭据（Credentials）；
- 指定分支（如 `*/main` 或 `*/develop`）。

#### 3.2.3 配置构建触发器
在「Build Triggers」部分，选择适合的触发器：

- **Poll SCM**：定期检查代码变更；
  - 日程表：`H/5 * * * *`（每 5 分钟检查一次）。
- **GitHub/GitLab hook**：代码推送时触发（需要额外配置 webhook）。

#### 3.2.4 配置构建环境

- 勾选「Provide Configuration files」（如果需要）；
- 勾选「Use secret text(s) or file(s)」（如果需要安全凭证）。

在「Build Environment」部分，可以：

- 勾选「Delete workspace before build starts」（清理工作区）；
- 勾选「Add timestamps to the Console Output」（日志加时间戳）。

#### 3.2.5 配置构建步骤

在「Build」部分，点击「Add build step」

选择「Invoke Gradle script」，配置如下：

- 选择 Gradle 版本：gradle-8.4（之前配置的）；
- Tasks：`clean assembleDebug`（或 `assembleRelease`）；
- 勾选「Make gradlew executable」（首次构建时）。

#### 3.2.6 配置构建后操作
在「Post-build Actions」部分，点击「Add post-build action」：

1. 选择「Archive the artifacts」；
   - Files to archive：`app/build/outputs/apk/debug/*.apk`。
2. 添加「Publish JUnit test result」；
   - Test report XMLs：`app/build/test-results/**/*.xml`。
3. 添加「Record JaCoCo coverage report」；
   - 配置覆盖率报告路径。

#### 3.2.7 保存并运行构建

点击「Save」，然后点击「Build Now」进行首次构建。

### 3.3 GitLab CI基础配置
GitLab CI 使用项目根目录下的 `.gitlab-ci.yml` 文件定义构建流程。

#### 3.3.1 创建基础配置文件

```yaml
# .gitlab-ci.yml
stages:
  - build
  - test
  - deploy

variables:
  ANDROID_COMPILE_SDK: "30"
  ANDROID_BUILD_TOOLS: "30.0.3"
  ANDROID_SDK_TOOLS: "6858069"

# 缓存配置
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .gradle/
    - app/build/

build:
  stage: build
  tags:
    - android
  script:
    - export GRADLE_USER_HOME=$(pwd)/.gradle
    - chmod +x gradlew
    - ./gradlew assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
    expire_in: 1 week
```

#### 3.3.2 配置说明

- **stages**：定义构建流程的阶段；
- **variables**：设置环境变量，便于维护和修改；
- **cache**：缓存 Gradle 和构建输出，加速后续构建；
- **build job**：
  - `stage`：属于 build 阶段；
  - `tags`：指定运行此作业的 runner 标签；
  - `script`：执行的命令；
  - `artifacts`：保存构建产物，可供后续阶段使用。

#### 3.3.3 高级缓存配置
为了更有效地利用缓存，可以优化配置：

```yaml
cache:
  key: ${CI_COMMIT_REF_SLUG}
  paths:
    - .gradle/wrapper
    - .gradle/caches
    - app/build/intermediates/compile_only_not_namespaced_r_class_jar/debug
    - app/build/intermediates/bundle_manifest/debug
    - app/build/intermediates/merged_manifests/debug
    - app/build/intermediates/annotation_processor_list/debug
    - app/build/intermediates/compile_library_classes_jar/debug
    - app/build/intermediates/generated_proguard_file/debug
    - app/build/intermediates/incremental/mergeDebugResources
    - app/build/intermediates/incremental/packageDebugResources
    - app/build/intermediates/javac/debug
    - app/build/intermediates/processed_res/debug
    - app/build/intermediates/res/merged/debug
    - app/build/intermediates/symbols/debug
    - app/build/outputs
  policy: pull-push
```

#### 3.3.4 多模块项目配置
对于多模块项目，可以扩展构建配置：

```yaml
build:
  stage: build
  tags:
    - android
  script:
    - export GRADLE_USER_HOME=$(pwd)/.gradle
    - chmod +x gradlew
    - ./gradlew :app:assembleDebug :library:assembleDebug
  artifacts:
    paths:
      - app/build/outputs/apk/debug/*.apk
      - library/build/outputs/aar/*.aar
    expire_in: 1 week
```

### 3.4 Gradle构建优化
为了加速 CI 构建，可以在 `gradle.properties` 中添加以下配置：

```properties
# 并行构建
org.gradle.parallel=true
# 启用构建缓存
org.gradle.caching=true
# 启用配置缓存（Gradle 6.6+）
org.gradle.unsafe.configuration-cache=true
# JVM内存配置
org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -Dfile.encoding=UTF-8
# 禁用Gradle守护进程（在CI环境中）
org.gradle.daemon=false
```

对于Jenkins，可以在构建步骤中添加这些参数：

```plain
tasks: clean assembleDebug
switches: --build-cache --parallel --max-workers=4
```

对于GitLab CI，可以在脚本中添加：

```yaml
script:
  - ./gradlew assembleDebug --build-cache --parallel --max-workers=4
```

---

> 下一篇我们将探讨「自动化测试集成」，敬请关注本系列。

**「Jenkins与GitLab CI实现Android持续集成与交付：从构建到发布的完整指南」系列目录**

1. 前言
2. **基础构建配置**（本文）
3. 自动化测试集成
4. 代码质量检查
5. 自动化发布与部署
6. 高级主题与最佳实践
7. 2.1 Jenkins多分支Pipeline
8. 2.2 GitLab CI企业级配置
