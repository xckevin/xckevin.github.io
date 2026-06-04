import avatar from '../assets/images/avatar.jpg';
import hero from '../assets/images/hero.jpg';
import type { Locale, SiteConfig, SiteLocaleConfig, TopicLink } from '../types';

const topicsZh: TopicLink[] = [
    {
        title: 'Android Framework',
        href: '/android-framework',
        description: 'Binder、系统服务、进程线程、权限、ContentProvider 与 Framework 交互链路。'
    },
    {
        title: 'Android 性能优化',
        href: '/android-performance',
        description: '冷启动、渲染、内存、Bitmap、Perfetto、Macrobenchmark 与稳定性治理。'
    },
    {
        title: 'Jetpack Compose',
        href: '/jetpack-compose',
        description: '重组、Stability、Modifier、手势、动画、Glance 与 View 互操作。'
    },
    {
        title: 'Kotlin 与协程',
        href: '/kotlin-coroutines',
        description: 'Coroutine、Flow、StateFlow、SharedFlow、K2 编译器与跨平台工程。'
    },
    {
        title: 'Android 端侧 AI',
        href: '/android-on-device-ai',
        description: 'Gemini Nano、AICore、NNAPI、端侧 LLM、RAG、多模态推理与模型治理。'
    },
    {
        title: '移动端工程化',
        href: '/android-engineering',
        description: 'CI/CD、测试、Gradle 构建、模块化、架构演进与团队协作。'
    },
    {
        title: 'AI 开发工具',
        href: '/ai-dev-tools',
        description: 'Codex、提示词工程、Ollama、OpenClaw 与 AI Agent 工程实践。'
    }
];

const topicsEn: TopicLink[] = [
    {
        title: 'Android Framework',
        href: '/en/android-framework',
        description: 'Binder, system services, process and thread models, permissions, ContentProvider, and Framework internals.'
    },
    {
        title: 'Android Performance',
        href: '/en/android-performance',
        description: 'Cold start, rendering, memory, Bitmap, Perfetto, Macrobenchmark, and production stability.'
    },
    {
        title: 'Jetpack Compose',
        href: '/en/jetpack-compose',
        description: 'Recomposition, stability, Modifier internals, gestures, animation, Glance, and View interoperability.'
    },
    {
        title: 'Kotlin and Coroutines',
        href: '/en/kotlin-coroutines',
        description: 'Coroutines, Flow, StateFlow, SharedFlow, the K2 compiler, and multiplatform engineering.'
    },
    {
        title: 'Android On-device AI',
        href: '/en/android-on-device-ai',
        description: 'Gemini Nano, AICore, NNAPI, on-device LLMs, RAG, multimodal inference, and model governance.'
    },
    {
        title: 'Mobile Engineering',
        href: '/en/android-engineering',
        description: 'CI/CD, testing, Gradle build systems, modularization, architecture evolution, and team practices.'
    },
    {
        title: 'AI Development Tools',
        href: '/en/ai-dev-tools',
        description: 'Codex, prompt engineering, Ollama, OpenClaw, and practical AI agent engineering.'
    }
];

const zh: SiteLocaleConfig = {
    title: 'Kai | Android Framework、性能优化与工程化深度解析',
    subtitle: 'Android Framework、性能优化、Jetpack Compose、Kotlin、端侧 AI 与移动端工程化深度笔记。',
    description: '系统整理 Android Framework、Jetpack Compose、性能优化、Kotlin、端侧 AI、CI/CD 与移动端工程化实践。',
    image: {
        src: hero,
        alt: 'Android Framework、性能优化与工程化知识库封面'
    },
    headerNavLinks: [
        { text: 'Home', href: '/' },
        { text: 'Topics', href: '/topics' },
        { text: 'Android', href: '/android-framework' },
        { text: 'Performance', href: '/android-performance' },
        { text: 'AI', href: '/android-on-device-ai' },
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
        text: '聚焦 Android Framework、性能优化、Jetpack Compose、Kotlin 协程、端侧 AI、CI/CD 与移动端架构治理，把源码链路、工程经验和排障方法整理成可检索的知识库。',
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
    topics: topicsZh
};

const en: SiteLocaleConfig = {
    title: 'Kai | Deep Android Engineering Notes',
    subtitle: 'Deep notes on Android Framework, performance, Jetpack Compose, Kotlin, on-device AI, and mobile engineering.',
    description:
        'A technical knowledge base covering Android Framework, Jetpack Compose, performance optimization, Kotlin, on-device AI, CI/CD, and mobile engineering practices.',
    image: {
        src: hero,
        alt: 'Deep Android engineering knowledge base cover'
    },
    headerNavLinks: [
        { text: 'Home', href: '/en/' },
        { text: 'Topics', href: '/en/topics' },
        { text: 'Android', href: '/en/android-framework' },
        { text: 'Performance', href: '/en/android-performance' },
        { text: 'AI', href: '/en/android-on-device-ai' },
        { text: 'Blog', href: '/en/blog' },
        { text: 'Tags', href: '/en/tags' }
    ],
    footerNavLinks: [
        { text: 'About', href: '/en/about' },
        { text: 'Contact', href: '/en/contact' },
        { text: 'Terms', href: '/en/terms' }
    ],
    socialLinks: [],
    hero: {
        title: 'Deep Android Engineering Notes',
        text: 'A searchable knowledge base for Android Framework internals, performance optimization, Jetpack Compose, Kotlin coroutines, on-device AI, CI/CD, and mobile architecture.',
        image: {
            src: hero,
            alt: 'Android engineering knowledge base cover'
        },
        actions: [
            { text: 'Topic Index', href: '/en/topics' },
            { text: 'Latest Posts', href: '/en/blog' }
        ]
    },
    subscribe: {
        enabled: false,
        title: 'Subscribe',
        text: 'Get the latest updates.',
        form: { action: '#' }
    },
    topics: topicsEn
};

const siteConfig: SiteConfig = {
    website: 'https://xckevin.com',
    avatar: {
        src: avatar,
        alt: '头像'
    },
    ...zh,
    locales: { zh, en },
    postsPerPage: 20,
    projectsPerPage: 8
};

export function getSiteConfig(locale: Locale = 'zh') {
    return siteConfig.locales[locale] ?? siteConfig.locales.zh;
}

export default siteConfig;
