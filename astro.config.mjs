import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';
import siteConfig from './src/data/site-config';
import blogRedirects from './src/data/blog-redirects.json';

// https://astro.build/config
export default defineConfig({
    site: siteConfig.website,
    base: '/',
    output: 'static',
    redirects: blogRedirects,
    vite: {
        plugins: [tailwindcss()]
    },
    integrations: [mdx(), sitemap()]
});
