import avatar from '../assets/images/avatar.jpg';
import hero from '../assets/images/hero.jpg';
import type { SiteConfig } from '../types';

const siteConfig: SiteConfig = {
    website: 'https://xckevin.com',
    avatar: {
        src: avatar,
        alt: '头像'
    },
    title: 'Kai | Android Framework、性能优化与工程化深度解析',
    subtitle: 'Android Framework、性能优化、Jetpack Compose、Kotlin 与移动端工程化深度笔记。',
    description: '系统整理 Android Framework、Jetpack Compose、性能优化、Kotlin、CI/CD 与移动端工程化实践。',
    image: {
        src: hero,
        alt: 'Android Framework、性能优化与工程化知识库封面'
    },
    headerNavLinks: [
        { text: 'Home', href: '/' },
        { text: 'Topics', href: '/topics' },
        { text: 'Android', href: '/android-framework' },
        { text: 'Performance', href: '/android-performance' },
        { text: 'Blog', href: '/blog' },
        { text: 'Tags', href: '/tags' }
    ],
    footerNavLinks: [
        { text: 'About', href: '/about' },
        { text: 'Contact', href: '/contact' },
        { text: 'Terms', href: '/terms' }
    ],
    socialLinks: [
        // 在此添加你的社交媒体链接，例如：
        // { text: 'GitHub', href: 'https://github.com/xckevin' },
        // { text: 'Twitter', href: 'https://twitter.com/xxx' }
    ],
    hero: {
        title: 'Android 深度技术笔记与工程化实践',
        text: '聚焦 Android Framework、性能优化、Jetpack Compose、Kotlin 协程、CI/CD 与移动端架构治理，把源码链路、工程经验和排障方法整理成可检索的知识库。',
        image: {
            src: hero,
            alt: 'Android 技术知识库封面'
        },
        actions: [
            { text: '专题索引', href: '/topics' },
            { text: '最新文章', href: '/blog' }
        ]
    },
    subscribe: {
        enabled: false,
        title: '订阅',
        text: '订阅获取最新动态。',
        form: { action: '#' }
    },
    postsPerPage: 20,
    projectsPerPage: 8
};

export default siteConfig;
