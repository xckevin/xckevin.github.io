"""Tests for notification boundaries; these do not call the network."""
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('notify', Path(__file__).with_name('notify-indexnow.py'))
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)
URL = 'https://xckevin.com/blog/android-perfetto/'
HTML = f'<html><head><link rel="canonical" href="{URL}"></head></html>'


class IndexNowBoundaries(unittest.TestCase):
    def test_deduplicates_and_ignores_comments(self):
        self.assertEqual(notify.validate_urls(['# changed pages', URL, URL, ''], 'xckevin.com'), [URL])

    def test_rejects_external_or_noncanonical_input(self):
        for url in [URL.replace('https:', 'http:'), URL+'?x=1', URL+'#a', 'https://evil.test/', 'https://xckevin.com@evil.test/', 'https://xckevin.com:443/blog/']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                notify.validate_urls([url], 'xckevin.com')

    def test_requires_nonempty_batch(self):
        with self.assertRaises(ValueError):
            notify.validate_urls([], 'xckevin.com')

    def test_accepts_self_canonical_html(self):
        notify.validate_page(URL, HTML, {'Content-Type': 'text/html; charset=utf-8'})

    def test_rejects_redirect_noindex_and_alternate_canonical(self):
        for html in [HTML.replace('</head>', '<meta name="robots" content="NOINDEX, follow"></head>'), HTML.replace('</head>', '<meta name="bingbot" content="none"></head>'), HTML.replace('</head>', '<meta http-equiv="refresh" content="0;url=/"></head>'), HTML.replace(URL, 'https://xckevin.com/'), HTML.replace('</head>', f'<link rel="canonical" href="{URL}"></head>')]:
            with self.subTest(html=html), self.assertRaises(ValueError):
                notify.validate_page(URL, html, {'Content-Type': 'text/html'})

    def test_rejects_non_html_and_header_noindex(self):
        for headers in [{'Content-Type': 'application/json'}, {'Content-Type': 'text/html', 'X-Robots-Tag': 'noindex'}]:
            with self.subTest(headers=headers), self.assertRaises(ValueError):
                notify.validate_page(URL, HTML, headers)


if __name__ == '__main__':
    unittest.main()
