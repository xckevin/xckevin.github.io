import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { getSiteConfig } from '../../data/site-config.ts';
import { sortItemsByDateDesc } from '../../utils/data-utils.ts';

export async function GET(context) {
    const site = getSiteConfig('en');
    const posts = (await getCollection('blogEn'))
        .filter(({ data }) => data.displayInBlog)
        .sort(sortItemsByDateDesc);
    return rss({
        title: site.title,
        description: site.description,
        site: context.site,
        items: posts.map((item) => ({
            title: item.data.title,
            description: item.data.excerpt,
            link: `/en/blog/${item.data.slug ?? item.id}/`,
            pubDate: item.data.publishDate.setUTCHours(0)
        }))
    });
}
