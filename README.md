# 个人主页

基于 [Dante Astro 主题](https://github.com/JustGoodUI/dante-astro-theme) 构建的 GitHub Pages 个人主页。

## 技术栈

- Astro.js
- Tailwind CSS
- Markdown / MDX

## 项目结构

```
├── src/
│   ├── assets/        # 静态资源（图片等）
│   ├── components/    # 组件
│   ├── content/       # 内容
│   │   ├── blog/      # 博客文章
│   │   ├── projects/  # 项目展示
│   │   └── pages/     # 静态页面（about、contact、terms）
│   ├── data/          # 配置（site-config.ts）
│   └── pages/         # 路由页面
```

## 快速开始

```bash
npm install
npm run dev      # 本地开发 http://localhost:4321
npm run build    # 构建
npm run preview  # 预览构建结果
```

## 添加内容

- **博客**：在 `src/content/blog/` 下新建 `.md` 或 `.mdx` 文件
- **项目**：在 `src/content/projects/` 下新建 `.md` 或 `.mdx` 文件
- **配置**：修改 `src/data/site-config.ts` 自定义站点信息、导航、社交链接等

## License

GPL-3.0
