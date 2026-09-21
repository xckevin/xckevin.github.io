#!/usr/bin/env python3
"""Audit rendered Astro HTML using only Python's standard library."""
import argparse
from collections import defaultdict
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import unquote, urlsplit
import xml.etree.ElementTree as ET

class Page(HTMLParser):
    def __init__(self):
        super().__init__(); self.title=''; self.in_title=False; self.h1=0; self.canonical=None; self.description=None; self.lang=None; self.alternates={}; self.links=[]; self.ids=set(); self.noindex=False; self.refresh=False; self.article=False; self.scripts=[]; self.ld=None
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if a.get('id'): self.ids.add(a['id'])
        if tag=='html':self.lang=a.get('lang')
        if tag=='title':self.in_title=True
        if tag=='h1':self.h1+=1
        if tag=='meta':
            if a.get('name')=='description':self.description=a.get('content')
            if a.get('name')=='robots':self.noindex='noindex' in a.get('content','')
            if a.get('http-equiv','').lower()=='refresh':self.refresh=True
            if a.get('property')=='og:type':self.article=a.get('content')=='article'
        if tag=='link':
            if a.get('rel')=='canonical':self.canonical=a.get('href')
            if a.get('hreflang'):self.alternates[a['hreflang']]=a.get('href')
        if tag=='a' and a.get('href'):self.links.append(a['href'])
        if tag=='script' and a.get('type')=='application/ld+json':self.ld=''
    def handle_endtag(self,tag):
        if tag=='title':self.in_title=False
        if tag=='script' and self.ld is not None:self.scripts.append(self.ld);self.ld=None
    def handle_data(self,data):
        if self.in_title:self.title+=data
        if self.ld is not None:self.ld+=data

def audit(root):
    pages={}; errors=[]; counts=defaultdict(int); titles=defaultdict(list); descriptions=defaultdict(list)
    def issue(kind,path,detail=''):errors.append({'kind':kind,'path':path,'detail':detail})
    for f in sorted(root.rglob('*.html')):
        path='/'+str(f.relative_to(root)).removesuffix('index.html');page=Page();html=f.read_text()
        if html.strip().startswith('google-site-verification:'):continue
        page.feed(html);pages[unquote(path)]=page
    if not pages:issue('missing_html',str(root))
    def path_of(url):return unquote(urlsplit(url).path).rstrip('/')+'/'
    for path,p in pages.items():
        counts['html']+=1
        if p.refresh:counts['redirects']+=1;continue
        if p.h1!=1:issue('h1',path,p.h1)
        if not p.canonical:issue('missing_canonical',path)
        if not p.description:issue('missing_description',path)
        if not p.title:issue('missing_title',path)
        if not p.lang:issue('missing_language',path)
        if p.canonical:
            target=path_of(p.canonical)
            if urlsplit(p.canonical).scheme!='https' or urlsplit(p.canonical).netloc!='xckevin.com':issue('canonical_origin',path,p.canonical)
            if target not in pages:issue('broken_canonical',path,p.canonical)
            if urlsplit(p.canonical).query or urlsplit(p.canonical).fragment:issue('canonical_parameters',path,p.canonical)
        for language,url in p.alternates.items():
            target=path_of(url)
            if target not in pages:issue('broken_hreflang',path,url);continue
            if urlsplit(url).netloc!='xckevin.com':issue('hreflang_origin',path,url)
            if pages[target].noindex or pages[target].refresh or not pages[target].canonical or path_of(pages[target].canonical)!=target:issue('hreflang_nonindexable',path,url)
            if pages[target].alternates!=p.alternates:issue('nonreciprocal_hreflang',path,url)
        for href in p.links:
            parsed=urlsplit(href)
            if parsed.scheme not in ('','https','http') or parsed.netloc not in ('','xckevin.com','xckevin.github.io'):continue
            if not parsed.path.startswith('/'):continue
            target=path_of(href)
            if target not in pages and not (root/unquote(parsed.path).lstrip('/')).is_file():issue('broken_link',path,href)
        if p.article and (path.startswith('/blog/') or path.startswith('/en/blog/')):
            counts['articles']+=1
            if not p.noindex and p.canonical and path_of(p.canonical)==path:
                counts['indexed_articles']+=1;titles[p.title].append(path);descriptions[p.description].append(path)
            if not p.scripts:issue('missing_structured_data',path)
            article_schema=False
            for script in p.scripts:
                try:
                    data=json.loads(script)
                    for item in data if isinstance(data,list) else [data]:
                        if item.get('@type') in ('Article','BlogPosting'):
                            article_schema=True
                            if item.get('mainEntityOfPage',{}).get('@id')!=p.canonical:issue('schema_canonical_mismatch',path)
                            if item.get('inLanguage')!=p.lang:issue('schema_language_mismatch',path)
                except (ValueError,AttributeError):issue('invalid_structured_data',path)
            if not article_schema:issue('missing_article_schema',path)
    for value,paths in titles.items():
        if len(paths)>1:issue('duplicate_article_title',paths,value)
    for value,paths in descriptions.items():
        if len(paths)>1:issue('duplicate_article_description',paths,value)
    sitemap_paths=set()
    for sitemap in root.glob('sitemap-*.xml'):
        tree=ET.parse(sitemap)
        for loc in tree.findall('.//{http://www.sitemaps.org/schemas/sitemap/0.9}url/{http://www.sitemaps.org/schemas/sitemap/0.9}loc'):
            path=path_of(loc.text);counts['sitemap_urls']+=1
            sitemap_paths.add(path)
            if path not in pages:issue('sitemap_missing_page',path)
            elif pages[path].refresh or pages[path].noindex or not pages[path].canonical or path_of(pages[path].canonical)!=path:issue('sitemap_noncanonical',path)
            elif urlsplit(loc.text).scheme!='https' or urlsplit(loc.text).netloc!=urlsplit(pages[path].canonical).netloc:issue('sitemap_origin',path,loc.text)
    if not counts['sitemap_urls']:issue('missing_sitemap_urls',str(root))
    for path,p in pages.items():
        if not p.refresh and not p.noindex and p.canonical and path_of(p.canonical)==path and path not in sitemap_paths:issue('indexable_page_missing_from_sitemap',path)
    return {'counts':dict(counts),'issueCounts':dict(__import__('collections').Counter(x['kind'] for x in errors)),'issues':errors}

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('dist',nargs='?',default='dist');ap.add_argument('--report');ap.add_argument('--strict',action='store_true');args=ap.parse_args();result=audit(Path(args.dist))
    if args.report:Path(args.report).write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k!='issues'},ensure_ascii=False,indent=2))
    raise SystemExit(1 if args.strict and result['issues'] else 0)
