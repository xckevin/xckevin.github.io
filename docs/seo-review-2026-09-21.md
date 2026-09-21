# 博客内容与 SEO 审查（2026-09-21）

## 范围与结果

审查基线为 `9f5611a`：422 篇中文、359 篇英文。第一阶段提交 `d35cdab` 为 42 篇新增完整中文文章提供英文译文；第二阶段审查全部 **823 个 Markdown 内容文件**（含历史拆分页和重复版本），修复内容结构、元数据、语言配对、内部链接和索引规则。

新增译文完整保留源文结构、日期、图片引用及 **244 个代码块**。独立校验检查了代码逐字一致、章节数量、正文长度、slug / translationKey / 日期对应和 SEO 字段约束。代码逐字保留是翻译一致性检查，不代表每段示例都经过编译或设备验证。

| 项目 | 基线 | 调整后 |
| --- | ---: | ---: |
| 内容文件 | 781 | 823 |
| 生成的文章页面 | 712 | 823 |
| 可索引且 canonical 指向自身的文章 | 712 | 657 |
| 已证实的双语配对 | 31 | 399 |
| 文章重复 SEO 标题组 | 2 | 0 |
| 文章重复描述组 | 1 | 0 |
| 生成页面的 H1 数量异常 | 5 | 0 |
| 站内页面死链 | 18 | 0 |
| 旧地址静态跳转 | 0 | 399 |

可索引文章数下降来自将 95 篇中文隐藏拆分、69 篇英文隐藏拆分排除索引，并将 2 篇重复英文归并到主文；完整正文仍可访问。英文隐藏拆分页此前没有生成独立页面，本次补齐直接访问能力。

## 内容修订

- 精简 197 个中文和 28 个英文 SEO 标题，保留区分主题的技术概念；浏览器文章标题使用短站点名 `Kai`，减少重复后缀占用。
- 补齐 ViewModel、Room 文章的 SEO 字段；修正电量诊断与 CI/CD 文章错用的标题。
- 修复电量诊断、CI/CD 的代码围栏开头和 ViewModel 的围栏结尾；按 Markdown 代码块边界处理多余 H1，保留代码内的 shell 注释。
- 补充 Instant Apps 停止提供、NNAPI 弃用、Context Receivers 被 Context Parameters 替代的说明。保留旧代码作为历史材料，并给出适用范围、官方来源和更新时间。
- 根据 AndroidX 源码修正 Compose `PopupLayout` 包装 `PopupWindow` 的错误描述；根据 Android API 文档修正 App Shortcuts 固定版本配额与自动截断的错误描述，中英文同步。
- 对实际查看的 4 张技术图，在 11 处引用补充具体的中英文替代文本。
- 修正英文推荐链接的语言路径、失效推荐和旧中文路径；相关文章按共享标签的稀有程度排序，让具体主题优先于泛化的 Android 标签。

此次覆盖全部文章的元数据、结构与链接，并核查识别出的技术时效问题；没有逐一运行所有历史技术示例，也没有声称完成 823 篇文章的逐句事实认证。其他图片的替代文本仍可继续改善。

## 双语与地址兼容

恢复 326 个历史中文 `translationKey`，其中 313 篇缺失 slug 的文章补齐 slug；已有 slug 保持稳定。证据来自 19 条 Git 历史、221 条精确代码匹配和 86 条直接内容复核。详细清单见 [配对证据](./seo-pairing-audit-2026-09-21.json)。加上原有 31 对和本次新增 42 对，共 399 对。23 篇中文未找到已证实的英文对应，不强行绑定相近主题。

- 配对文章输出包含自身、对应语言和 `x-default` 的双向 hreflang；未配对或不适合索引的文章不声明错误替代页。
- 所有原始 422 个中文有效地址都已验证存在。变更路径通过 `src/data/blog-redirects.json` 指向规范路径；站内正文链接直接使用规范路径。
- `android-edge-to-edge-windowinsets` 归并到 `android-16-edge-to-edge-windowinsets`；`android-app-shortcuts` 归并到 `android-app-shortcuts-shortcutmanager-deep-dive`。重复全文保留原地址，canonical 指向主文，并移出列表及 sitemap。
- GitHub Pages 当前是 Astro 静态输出。旧地址使用 Astro 生成的即时 meta refresh 与 canonical，HTTP 状态仍可能是 200，并非服务器 301；以后迁移到支持服务端重定向的平台时，可复用该映射配置 301。

## 站点实现

- canonical、Open Graph URL、分享 URL 和 BlogPosting JSON-LD 使用一致的规范地址；canonical 去除 query/hash。
- 正常隐藏拆分输出 `noindex, follow`，完整重复内容通过 canonical 归并，避免同时发送冲突的 noindex 归并信号。
- sitemap 根据已生成 HTML 过滤跳转页、noindex 页面和非自身 canonical 页面，并验证完整 origin。CI 直接使用配置中的自定义域名，避免 Pages 输出覆盖成 github.io。
- BlogPosting 使用实际文章标题与原始发布日期；仅实质内容修订设置 `updatedDate`。JSON-LD 安全转义 `<`。
- 中文归档分页与双语标签分页提供对应页码的标题和描述；只在真正对应的归档首页输出语言互链。
- 隐藏文章的独有标签显示为文本，避免链接到未生成的标签归档。
- RSS 使用原始日期对象，避免通过 `setUTCHours()` 修改共享内容数据。

## 验证与后续维护

运行：

```sh
npm run build
npm run seo:check
```

`seo:check` 使用 Python 标准库检查构建后的标题、描述、语言、H1、canonical、双向 hreflang、BlogPosting、站内页面链接、文章重复元数据和 sitemap。CI 在上传 Pages 产物之前执行同一检查，失败会阻止部署。最终检查覆盖 2,579 个 HTML 页面、823 篇文章和 2,014 个 sitemap URL，零异常。另以最小样例验证空构建、错误域名、noindex 误入 sitemap 和 sitemap 漏页均会失败。独立复核后已修正域名与 sitemap 完整性检查盲区。

后续同步中文源文时务必保留已有 `slug` 和 `translationKey`；发布英文版时使用同一个 key。变更任何已公开 slug 必须增加旧地址映射。隐藏拆分不要放回公开索引；完整文章的内容更新才修改 `updatedDate`。新增文章应明确技术版本、问题、方案和验证条件，避免重复泛化标题。

英文归档目前一次展示 330 篇文章，后续可参考中文归档增加分页，改善列表加载与浏览体验。

搜索结果的收录与排名需通过 Search Console 在后续数周观察；本次完成站内修复，没有提交站外消息或声称排名已经提升。

## 参考来源

- [Google：多语言页面与 hreflang](https://developers.google.com/search/docs/specialty/international/localized-versions)
- [Google：canonical 与重复 URL](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Google：标题链接](https://developers.google.com/search/docs/appearance/title-link)与[搜索摘要](https://developers.google.com/search/docs/appearance/snippet)
- [Astro：静态重定向](https://docs.astro.build/en/guides/routing/#redirects)
- [Android：Google Play Instant 状态](https://developer.android.com/topic/google-play-instant/overview)
- [Android：NNAPI 弃用说明](https://developer.android.com/ndk/guides/neuralnetworks)
- [Kotlin：Context Parameters](https://kotlinlang.org/docs/context-parameters.html)
- [AndroidX：PopupLayout 实现](https://github.com/androidx/androidx/blob/androidx-main/compose/ui/ui/src/androidMain/kotlin/androidx/compose/ui/window/AndroidPopup.android.kt)
- [Android：ShortcutManager API](https://developer.android.com/reference/android/content/pm/ShortcutManager)与[捷径管理](https://developer.android.com/develop/ui/compose/system/shortcuts/managing-shortcuts)
