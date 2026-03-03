# xckevin.github.io

基于 Astro 5 构建的个人网站与博客，支持文章/项目展示、标签归档、RSS、评论与 GitHub Pages 自动部署。

## 功能概览

- 内容驱动：`blog`、`projects`、`pages` 三类内容集合
- 首页聚合：展示精选文章与精选项目
- 标签系统：`/tags` 与标签分页详情页
- 分页归档：博客与项目列表分页
- SEO 基础能力：页面元信息、站点地图、RSS
- 评论系统：Giscus（GitHub Discussions）
- 主题切换：浅色/深色模式切换
- 静态部署：GitHub Actions 自动构建并发布到 GitHub Pages

## 技术栈

- Astro `^5.15.9`
- Tailwind CSS `^4.1.17`
- MDX（`@astrojs/mdx`）
- RSS（`@astrojs/rss`）
- Sitemap（`@astrojs/sitemap`）

## 目录结构

```text
.
├── .github/workflows/astro.yml   # GitHub Pages CI/CD
├── public/                       # 公共静态资源
├── src/
│   ├── assets/                   # 文章与站点图片资源
│   ├── components/               # UI 组件（含 Giscus、目录、分页等）
│   ├── content/
│   │   ├── blog/                 # 博客内容
│   │   ├── projects/             # 项目内容
│   │   └── pages/                # 静态页面内容
│   ├── data/site-config.ts       # 站点核心配置
│   ├── layouts/                  # 页面布局
│   ├── pages/                    # 路由页面与 RSS 入口
│   └── content.config.ts         # 内容 schema 定义
├── astro.config.mjs
└── package.json
```

## 环境要求

- Node.js 20+
- npm（仓库默认）或 pnpm（本地也可用）

## 本地开发

```bash
# 安装依赖
npm ci

# 启动开发服务（默认 http://localhost:4321）
npm run dev

# 构建产物到 dist/
npm run build

# 本地预览构建结果
npm run preview
```

## 内容模型（Frontmatter）

`src/content.config.ts` 对内容字段有校验，新增内容时请按以下字段填写。

### blog

- 必填：`title`、`publishDate`
- 常用：`excerpt`、`updatedDate`、`tags`
- 开关：`isFeatured`（默认 `true`）、`displayInBlog`（默认 `true`）
- 可选：`series`、`seo`

### projects

- 必填：`title`、`publishDate`
- 常用：`description`
- 开关：`isFeatured`（默认 `false`）
- 可选：`seo`

### pages

- 必填：`title`
- 可选：`seo`

## 关键配置

### 1) 站点信息

修改 `src/data/site-config.ts`：

- 站点地址、标题、副标题、描述
- 导航链接与页脚链接
- 首页 Hero 内容
- 分页大小：`postsPerPage`、`projectsPerPage`

### 2) 评论（Giscus）

修改 `src/components/Giscus.astro` 中的配置：

- `data-repo`、`data-repo-id`
- `data-category`、`data-category-id`
- `data-mapping`、`data-theme`

### 3) 统计（Google Analytics）

当前布局中已接入 gtag，配置位于 `src/layouts/BaseLayout.astro`。

## 部署

推送到 `main` 分支后，GitHub Actions 会自动：

1. 安装依赖
2. 执行 Astro 构建
3. 发布 `dist/` 到 GitHub Pages

工作流文件： `.github/workflows/astro.yml`

## 常见问题

- `Could not find Sharp`：本地构建若出现该错误，请先安装 `sharp`，例如执行 `npm i sharp -D` 后再 `npm run build`。

## License

GPL-3.0
