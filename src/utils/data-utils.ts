import { type CollectionEntry } from 'astro:content';
import { slugify } from './common-utils';

type DatedCollectionEntry = CollectionEntry<'blog' | 'blogEn' | 'projects'>;
type BlogCollectionEntry = CollectionEntry<'blog' | 'blogEn'>;

export function sortItemsByDateDesc(itemA: DatedCollectionEntry, itemB: DatedCollectionEntry) {
    return new Date(itemB.data.publishDate).getTime() - new Date(itemA.data.publishDate).getTime();
}

export function getAllTags(posts: BlogCollectionEntry[]) {
    const tags: string[] = [...new Set(posts.flatMap((post) => post.data.tags || []).filter(Boolean))];
    return tags
        .map((tag) => {
            return {
                name: tag,
                id: slugify(tag)
            };
        })
        .filter((obj, pos, arr) => {
            return arr.map((mapObj) => mapObj.id).indexOf(obj.id) === pos;
        });
}

export function getPostsByTag(posts: BlogCollectionEntry[], tagId: string) {
    const filteredPosts: BlogCollectionEntry[] = posts.filter((post) => (post.data.tags || []).map((tag) => slugify(tag)).includes(tagId));
    return filteredPosts;
}
