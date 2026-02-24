import avatar from '../assets/images/avatar.jpg';
import hero from '../assets/images/hero.jpg';
import type { SiteConfig } from '../types';

const siteConfig: SiteConfig = {
    website: 'https://xckevin.github.io',
    avatar: {
        src: avatar,
        alt: '头像'
    },
    title: 'Kai - 个人主页',
    subtitle: '这是我的个人主页，欢迎来访。',
    description: '个人主页，记录学习与生活。',
    image: {
        src: '/favicon.svg',
        alt: '个人主页'
    },
    headerNavLinks: [
        { text: 'Home', href: '/' },
        { text: 'Projects', href: '/projects' },
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
        title: '欢迎来到我的个人主页',
        text: '欢迎！这里将展示我的学习与生活点滴。你可以在 `src/data/site-config.ts` 中修改此内容。',
        image: {
            src: hero,
            alt: 'Hero 图片'
        },
        actions: [
            { text: '联系我', href: '/contact' }
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
