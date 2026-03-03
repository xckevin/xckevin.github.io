---
title: xckevin.github.io
description: 基于 Astro 5 构建的个人网站与博客，支持博客与项目展示、标签归档、RSS、评论和 GitHub Pages 自动部署。
publishDate: 2026-03-03
isFeatured: true
seo:
  title: xckevin.github.io | Astro 个人网站与博客项目
  description: 使用 Astro 5 与 Tailwind CSS 4 构建，包含内容集合、标签分页、RSS、Giscus 评论与 GitHub Pages 自动部署。
  pageType: website
---

`xckevin.github.io` 是一个以内容为中心的个人网站项目，基于 Astro 5 构建，覆盖博客写作、项目展示与站点配置化管理。

## 核心能力

- 内容集合：`blog`、`projects`、`pages`
- 首页聚合：精选文章与精选项目
- 标签系统：标签页与标签详情分页
- 分页归档：博客/项目列表分页
- SEO 支持：页面元信息、Sitemap、RSS
- 评论系统：Giscus（GitHub Discussions）
- 主题切换：浅色/深色模式
- CI/CD：GitHub Actions 自动发布到 GitHub Pages

## 技术栈

- Astro `^5.15.9`
- Tailwind CSS `^4.1.17`
- `@astrojs/mdx`
- `@astrojs/rss`
- `@astrojs/sitemap`

## 项目结构

```text
src/
├── components/        # UI 组件（评论、目录、分页等）
├── content/           # blog / projects / pages 内容
├── data/              # 站点配置
├── layouts/           # 页面布局
└── pages/             # 路由页面
```

## 运行与部署

```bash
npm ci
npm run dev
npm run build
npm run preview
```

推送到 `main` 分支后，GitHub Actions 会自动构建并发布 `dist/` 到 GitHub Pages。

## 仓库地址

- https://github.com/xckevin/xckevin.github.io
