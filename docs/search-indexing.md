# Publishing and search discovery

Keep existing article slugs stable. Improve the matching language version and link it from a relevant topic page. Use `updatedDate` only for meaningful editorial changes. The sitemap reads each article's rendered `article:modified_time`; it does not set every page to the build date.

## Before notifying search engines

1. Run `pnpm build` and `pnpm seo:check`.
2. Publish, wait for the GitHub Pages workflow, and check the actual content on `https://xckevin.com/`. The custom domain has its own deployment; a successful GitHub job alone is insufficient.
3. Prepare a UTF-8 file containing only newly added or materially updated canonical URLs, one per line. Include both languages when both changed. Do not submit the whole historical sitemap after a template-only build.
4. Run `python3 scripts/notify-indexnow.py /tmp/changed-urls.txt` to validate. Add `--submit` to notify IndexNow after confirming the deployed content.

The script checks the public verification file, HTTP 200, HTML content type, self-canonical URL, robots directives and redirects. It refuses the entire batch on a validation failure. It does not compare the live article body with a local commit, so step 2 remains necessary. Requests are not retried automatically, including rate-limit responses.

The **Notify IndexNow of published changes** GitHub Actions workflow offers the same explicit operation on `main`. It defaults to validation only. It is intentionally not attached to every build, since a stylesheet or template edit does not mean every article changed. The key in `scripts/indexnow-config.json` is a site ownership verification value backed by its public root `.txt` file, not an account credential.

HTTP 200 means the batch was received; 202 means key verification is pending. Neither means the URLs were crawled, indexed or ranked. This tool handles added/updated indexable HTML pages; removal notifications need a separate flow because this validator deliberately rejects 404/410 responses.

## Google and Bing follow-up

- Keep `https://xckevin.com/sitemap-index.xml` submitted in Search Console and Bing Webmaster Tools. Google uses its own discovery and indexing systems; an IndexNow submission is not a Google indexing request.
- For a small number of important Google pages, inspect the canonical URL and request indexing after a meaningful update when appropriate. Repeating the request does not accelerate crawling.
- Compare the same 28-day window by query, canonical page, language and device. Track impressions, clicks and position separately; confirm that changes preceded the measurement period.

References: [IndexNow protocol](https://www.indexnow.org/documentation), [Bing IndexNow guidance](https://www.bing.com/indexnow/getstarted), [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), [Google recrawl requests](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).
