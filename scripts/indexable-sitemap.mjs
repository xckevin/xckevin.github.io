import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sitemap from '@astrojs/sitemap';

/** Keep sitemap URLs aligned with the metadata in the rendered static pages. */
export function indexableSitemap() {
    let outputDirectory;
    const integration = sitemap({
        filter(page) {
            const pathname = decodeURIComponent(new URL(page).pathname);
            const html = readFileSync(join(outputDirectory, pathname, 'index.html'), 'utf8');
            const head = html.slice(0, html.indexOf('</head>'));
            if (/<meta\b[^>]*name="robots"[^>]*content="[^"]*noindex/i.test(head)) return false;
            if (/<meta\b[^>]*http-equiv="refresh"/i.test(head)) return false;
            const canonical = head.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i)?.[1];
            if (!canonical) return false;
            const canonicalURL = new URL(canonical);
            if (canonicalURL.origin !== new URL(page).origin) {
                throw new Error(`Sitemap origin differs from canonical: ${page} -> ${canonical}`);
            }
            return decodeURIComponent(canonicalURL.pathname) === pathname;
        }
    });
    const configure = integration.hooks['astro:config:done'];
    integration.hooks['astro:config:done'] = async (context) => {
        outputDirectory = fileURLToPath(context.config.outDir);
        await configure?.(context);
    };
    return integration;
}
