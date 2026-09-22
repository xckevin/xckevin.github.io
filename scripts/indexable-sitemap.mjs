import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sitemap from '@astrojs/sitemap';

/** Keep sitemap URLs aligned with the metadata in the rendered static pages. */
export function indexableSitemap() {
    let outputDirectory;
    const modifiedDates = new Map();
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
            const modified = head.match(/<meta\b[^>]*property="article:modified_time"[^>]*content="([^"]+)"/i)?.[1];
            if (modified && Number.isFinite(Date.parse(modified))) {
                modifiedDates.set(page, new Date(modified).toISOString());
            }
            return decodeURIComponent(canonicalURL.pathname) === pathname;
        },
        serialize(item) {
            // Article dates describe actual editorial changes, not the build time.
            const lastmod = modifiedDates.get(item.url);
            return lastmod ? { ...item, lastmod } : item;
        }
    });
    const configure = integration.hooks['astro:config:done'];
    integration.hooks['astro:config:done'] = async (context) => {
        outputDirectory = fileURLToPath(context.config.outDir);
        await configure?.(context);
    };
    return integration;
}
