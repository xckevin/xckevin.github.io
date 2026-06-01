---
title: "Android CI/CD 质量门禁应该包含什么？"
slug: android-ci-cd-quality-gates
excerpt: "整理 Android CI/CD 中构建、测试、Lint、签名、性能基准、发布和回滚的质量门禁设计。"
publishDate: '2026-06-01'
tags:
- "Android"
- "CI/CD"
- "工程化"
seo:
  title: "Android CI/CD 质量门禁：构建、测试、Lint、性能与发布检查"
  description: "介绍 Android CI/CD 质量门禁设计，覆盖 Jenkins、GitLab CI、单元测试、Lint、签名、性能基准、发布和回滚。"
---

Android CI/CD 的目标不是“自动打包”，而是把质量风险挡在合并、发布和灰度之前。流水线如果只会产出 APK 或 AAB，它只是远程构建机；真正的 CI/CD 应该把编译、测试、静态检查、性能、签名、发布策略全部变成可重复的门禁。

## 门禁要按阶段设计

我通常把 Android 质量门禁分成三层：合并前、主干构建、发布前。三层关注的问题不一样，混成一条超长流水线会让反馈变慢，也会让团队绕过门禁。

合并前门禁追求快，目标是阻止明显错误进入主干。这里应该跑 Debug 编译、受影响模块单元测试、增量 Lint、Ktlint/Detekt、API 兼容检查。时间最好控制在 10 分钟以内，否则开发者会倾向于批量提交或跳过检查。

主干构建追求稳定，目标是确认主分支随时可发布。这里应该跑全量构建、核心模块测试、集成测试、依赖漏洞扫描、资源重复检查和包体积统计。主干失败必须有人值守，否则红灯会很快变成背景噪音。

发布前门禁追求风险控制，目标是确认这个版本能进入灰度。这里需要 Release 构建、签名校验、Proguard/R8 mapping 归档、渠道配置、版本号检查、冒烟测试、性能基准和回滚包准备。

## 基础门禁：先保证包是可信的

最基础的一组门禁包括：

- Debug 和 Release 都能构建成功，避免只验证开发包。
- 单元测试通过，尤其是 ViewModel、Repository、领域逻辑和工具类。
- Android Lint 不允许新增 error，warning 可以按模块逐步收敛。
- 签名配置、versionCode、applicationId、渠道参数必须可验证。
- 产物哈希、mapping、native symbol、构建日志必须归档。

这几项看起来普通，但很多线上事故都来自这里：错签名、错环境、漏 mapping、灰度包和正式包配置不一致。CI 的价值不是让人少点按钮，而是让这些低级错误没有机会进入发布流程。

## 进阶门禁：把回归前移

当基础门禁稳定后，再加三类进阶检查。

第一类是 UI 冒烟。不要一开始就追求覆盖所有页面，先覆盖启动、登录、首页、核心交易或核心内容流。Compose 项目可以利用语义树做更稳定的断言，传统 View 项目可以用 Espresso 或 Maestro 组织主链路。

第二类是性能回归。Macrobenchmark 适合放在发布前或 nightly，因为它需要真实设备、冷启动控制和多轮采样。门禁指标可以从启动 p95、列表滑动帧率、关键页面加载时间、包体积增长开始，不要一次性塞进十几个指标。

第三类是依赖和安全。Gradle dependency lock、License 检查、已知漏洞扫描、敏感权限变化、Manifest diff 都应该进入流水线。Android 项目依赖链很长，依赖升级带来的行为变化经常比业务代码更隐蔽。

## 质量门禁不要变成发布阻力

门禁设计的核心矛盾是：越严格越安全，越慢越容易被绕过。解决方式不是降低标准，而是分层、缓存和并行。

合并前只跑必要检查；主干和 nightly 跑重检查；发布前跑最接近真实用户环境的检查。Gradle Build Cache、Configuration Cache、测试分片、模块影响分析都应该服务于这个目标。CI 速度本身也是工程质量的一部分。

失败策略也要清晰。编译失败、签名错误、核心测试失败必须阻断；普通 Lint warning 可以先记录趋势；性能指标可以设置黄色区间和红色区间，黄色需要人工确认，红色直接阻断。门禁如果没有分级，最后往往只能靠人情豁免。

## 发布后还需要一层线上门禁

Android 发布不是上传商店后就结束。灰度阶段应继续观察 crash-free、ANR、启动 p95、核心接口错误率、登录转化、包体积安装失败率。如果指标越过阈值，流水线应该能暂停继续放量，并保留回滚或撤包路径。

成熟的 CI/CD 不是一条 YAML，而是一套从提交到灰度的风险控制系统。自动化只是形式，真正重要的是每个阶段知道自己要挡住什么风险。

<!-- seo-internal-links -->

## 深入阅读

- [返回对应专题：移动端工程化](/android-engineering/)
- [Android CI/CD 实践：Jenkins、GitLab CI、构建发布与质量门禁](/blog/jenkins与gitlab-ci实现android持续集成与交付从构建到发布的完整指南/)
- [Android 测试工程实践：JUnit、集成测试、Compose 语义与 CI](/blog/2026-05-10-深入_android_测试全链路工程实践_从_junit_单元测试到_compose_semanti/)
- [Android Gradle 构建慢怎么分析？](/blog/android-gradle-build-slow/)
<!-- /seo-internal-links -->
