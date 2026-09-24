import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

// Execute the generated HTML, so an Astro serialization regression cannot pass
// merely because the source contains the intended JavaScript.
const pages = [
    'index.html',
    'topics/index.html',
    'blog/agp-9-r8-workmanager-inputmerger-constructor/index.html',
    'en/blog/agp-9-r8-workmanager-inputmerger-constructor/index.html'
];

function createBrowser(href) {
    const redirects = [];
    const scripts = [];
    const location = new URL(href);
    location.replace = (url) => redirects.push(url);
    const window = { location };
    const document = {
        createElement(name) {
            assert.equal(name, 'script');
            return {};
        },
        head: { appendChild: (element) => scripts.push(element) }
    };
    return { context: vm.createContext({ window, document, URL }), window, redirects, scripts };
}

const redirects = JSON.parse(readFileSync('src/data/blog-redirects.json', 'utf8'));
const destinationRuntime = readFileSync('dist/index.html', 'utf8').match(/<script\b[^>]*id="site-runtime"[^>]*>([\s\S]*?)<\/script>/i)[1];

for (const origin of ['https://xckevin.github.io', 'https://xckevin.com', 'http://localhost:4321']) {
    test(`all historical aliases on ${origin} retain query and hash without tracking the redirect page`, () => {
        for (const [from, to] of Object.entries(redirects)) {
            const html = readFileSync(resolve('dist', `.${from}index.html`), 'utf8');
            const script = html.match(/<script\b[^>]*id="legacy-path-redirect"[^>]*>([\s\S]*?)<\/script>/i)?.[1];
            assert.ok(script, `Missing redirect script for ${from}`);
            assert.match(html, /<noscript><meta\b[^>]*http-equiv="refresh"[^>]*><\/noscript>/i);
            assert.doesNotMatch(html, /googletagmanager|google-analytics|gtag\(/);

            const suffix = '?utm_source=test&next=%2Ftopics%2F#section';
            const browser = createBrowser(origin + from + suffix);
            vm.runInContext(script, browser.context);
            assert.deepEqual(browser.redirects, [origin + to + suffix], from);
            assert.deepEqual(browser.scripts, []);

            // Execute the real next-page bootstrap to cover old domain + old path.
            const destination = createBrowser(browser.redirects[0]);
            vm.runInContext(destinationRuntime, destination.context);
            if (origin === 'https://xckevin.github.io') {
                assert.deepEqual(destination.redirects, ['https://xckevin.com' + to + suffix]);
                assert.deepEqual(destination.scripts, []);
            } else if (origin === 'http://localhost:4321') {
                assert.deepEqual(destination.redirects, []);
                assert.deepEqual(destination.scripts, []);
            } else {
                assert.deepEqual(destination.redirects, []);
                assert.equal(destination.scripts.length, 1);
            }
        }
    });
}

for (const page of pages) {
    const html = readFileSync(resolve('dist', page), 'utf8');
    const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1];
    const inline = [...(head || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((match) => /\bid="site-runtime"/.test(match[1]));

    test(`${page}: analytics bootstrap is in head with no unconditional tag or body redirect`, () => {
        assert.equal(inline.length, 1);
        assert.doesNotMatch(html, /<script\b[^>]*\bsrc=["'][^"']*(?:googletagmanager\.com|google-analytics\.com|canonical-redirect\.js)/i);
    });

    test(`${page}: canonical visits initialize once, including a repeated inline execution`, () => {
        const browser = createBrowser('https://xckevin.com/blog/example/?utm_source=test#section');
        vm.runInContext(inline[0][2], browser.context);
        // A soft navigation retains the same window and must retain the loaded tag.
        browser.window.location.href = 'https://xckevin.com/topics/';
        vm.runInContext(inline[0][2], browser.context);
        assert.deepEqual(browser.redirects, []);
        assert.equal(browser.scripts.length, 1);
        assert.equal(browser.scripts[0].src, 'https://www.googletagmanager.com/gtag/js?id=G-VFX5Y8E9RR');
        assert.equal(browser.scripts[0].async, true);
        assert.deepEqual(
            Array.from(browser.window.dataLayer, (args) => args[0]),
            ['js', 'config']
        );
        assert.equal(browser.window.dataLayer[1][1], 'G-VFX5Y8E9RR');
    });

    for (const origin of ['https://xckevin.github.io', 'https://www.xckevin.com', 'http://xckevin.com', 'http://www.xckevin.com', 'https://xckevin.com:4321']) {
        test(`${page}: ${origin} redirects without loading analytics`, () => {
            const suffix = '/en/blog/example/?utm_source=test&x=1#section';
            const browser = createBrowser(origin + suffix);
            vm.runInContext(inline[0][2], browser.context);
            assert.deepEqual(browser.redirects, ['https://xckevin.com' + suffix]);
            assert.deepEqual(browser.scripts, []);
            assert.equal(browser.window.dataLayer, undefined);
            assert.equal(browser.window.gtag, undefined);
        });
    }

    for (const origin of [
        'http://localhost:4321',
        'http://127.0.0.1:4321',
        'http://[::1]:4321',
        'http://192.168.1.20:4321',
        'https://preview.xckevin-homepage.pages.dev',
        'https://preview.xckevin-homepage.workers.dev'
    ]) {
        test(`${page}: ${origin} remains a preview without analytics`, () => {
            const browser = createBrowser(origin + '/topics/');
            vm.runInContext(inline[0][2], browser.context);
            assert.deepEqual(browser.redirects, []);
            assert.deepEqual(browser.scripts, []);
            assert.equal(browser.window.dataLayer, undefined);
            assert.equal(browser.window.gtag, undefined);
        });
    }
}
