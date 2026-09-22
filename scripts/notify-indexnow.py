#!/usr/bin/env python3
"""Validate an explicit batch of live, canonical pages; submit only with --submit."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Metadata(HTMLParser):
    def __init__(self):
        super().__init__()
        self.canonicals = []
        self.blocked = False

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'link' and values.get('rel', '').lower() == 'canonical':
            self.canonicals.append(values.get('href'))
        if tag == 'meta':
            name = values.get('name', '').lower()
            if name in ('robots', 'bingbot') and re.search(r'\b(noindex|none)\b', values.get('content', ''), re.I):
                self.blocked = True
            if values.get('http-equiv', '').lower() == 'refresh':
                self.blocked = True


def validate_urls(lines, host):
    urls = []
    for line in lines:
        url = line.strip()
        if not url or url.startswith('#'):
            continue
        parsed = urlsplit(url)
        if (parsed.scheme != 'https' or parsed.netloc != host or parsed.query or
                parsed.fragment or not parsed.path.startswith('/') or
                any(c.isspace() for c in url)):
            raise ValueError(f'Only canonical HTTPS URLs on {host}, without query or fragment, are allowed: {url}')
        if url not in urls:
            urls.append(url)
    if not 1 <= len(urls) <= 10000:
        raise ValueError('Provide between 1 and 10,000 changed URLs.')
    return urls


def fetch(url):
    request = Request(url, headers={'User-Agent': 'xckevin-indexnow-check/1.0'})
    # Do not send a changed alias or follow an unexpected redirect to another host.
    with build_opener(NoRedirect).open(request, timeout=30) as response:
        if response.status != 200:
            raise ValueError(f'Expected HTTP 200: {url} ({response.status})')
        return response.read().decode('utf-8'), response.headers


def validate_page(url, html, headers):
    if 'text/html' not in headers.get('Content-Type', '').lower():
        raise ValueError(f'Expected an HTML page: {url}')
    parser = Metadata()
    parser.feed(html)
    robots = ','.join(headers.get_all('X-Robots-Tag', [])) if hasattr(headers, 'get_all') else headers.get('X-Robots-Tag', '')
    if parser.blocked or re.search(r'\b(noindex|none)\b', robots, re.I):
        raise ValueError(f'Page is marked noindex or redirects: {url}')
    if parser.canonicals != [url]:
        raise ValueError(f'Page is not self-canonical: {url} -> {parser.canonicals}')


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('urls_file', type=Path, help='UTF-8 file: one recently added or updated canonical URL per line')
    ap.add_argument('--submit', action='store_true', help='POST the validated batch to IndexNow (default: validate only)')
    args = ap.parse_args()
    config = json.loads(Path(__file__).with_name('indexnow-config.json').read_text())
    host, key = config['host'], config['key']
    if host != 'xckevin.com' or not re.fullmatch(r'[a-zA-Z0-9-]{8,128}', key):
        raise ValueError('Invalid site configuration')
    urls = validate_urls(args.urls_file.read_text().splitlines(), host)
    key_url = f'https://{host}/{key}.txt'
    key_body, _ = fetch(key_url)
    if key_body.strip() != key:
        raise ValueError('IndexNow verification file is not deployed or does not match.')

    def check(url):
        html, headers = fetch(url)
        validate_page(url, html, headers)
        return url

    with ThreadPoolExecutor(max_workers=4) as pool:
        checked = list(pool.map(check, urls))
    print(f'Validated {len(checked)} live, self-canonical HTML pages and the verification file.')
    if not args.submit:
        print('Validation only. No URLs submitted. Re-run with --submit after verifying the content deployment.')
        return
    payload = json.dumps({'host': host, 'key': key, 'keyLocation': key_url, 'urlList': checked}).encode()
    request = Request('https://api.indexnow.org/indexnow', data=payload,
                      headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with build_opener(NoRedirect).open(request, timeout=30) as response:
        if response.status not in (200, 202):
            raise ValueError(f'Unexpected IndexNow status: {response.status}')
        state = 'received' if response.status == 200 else 'received; key validation pending'
        print(f'IndexNow HTTP {response.status}: {len(checked)} URLs {state}. This does not confirm indexing.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, HTTPError) as error:
        raise SystemExit(f'IndexNow stopped without retry: {error}')
