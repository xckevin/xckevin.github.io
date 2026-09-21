import { writeFile } from 'node:fs/promises';

/** Emit HTTP redirects for Workers Assets while Astro retains the HTML fallback. */
export function cloudflareRedirects(redirects) {
    return {
        name: 'blog-cloudflare-redirects',
        hooks: {
            'astro:build:done': async ({ dir }) => {
                const rules = new Map();
                for (const [from, to] of Object.entries(redirects)) {
                    if (![from, to].every((path) => /^\/(?!\/)[^\s?#*:%\\]+\/$/.test(path))) {
                        throw new Error(`Redirects must use absolute internal paths: ${from} -> ${to}`);
                    }
                    if (from === to || redirects[to]) throw new Error(`Redirect cycle or chain: ${from}`);
                    for (const source of [from, from.slice(0, -1)]) {
                        const encoded = encodeURI(source);
                        const rule = `${encoded} ${encodeURI(to)} 301`;
                        if (rule.length > 1000) throw new Error(`Redirect exceeds Cloudflare's line limit: ${from}`);
                        if (rules.has(encoded)) throw new Error(`Duplicate redirect source: ${source}`);
                        rules.set(encoded, rule);
                    }
                }
                if (rules.size > 2000) throw new Error('Cloudflare static redirect limit exceeded');
                await writeFile(new URL('_redirects', dir), '# Generated from src/data/blog-redirects.json\n' + [...rules.values()].join('\n') + '\n');
            }
        }
    };
}
