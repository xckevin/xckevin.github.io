import type { Locale } from '../types';
import { getLocalizedPostPath } from './i18n';

const readableSlugMap: Record<string, string> = {
    Android: 'android',
    'Jetpack Compose': 'jetpack-compose',
    Compose: 'compose',
    Kotlin: 'kotlin',
    'Kotlin Flow': 'kotlin-flow',
    'Kotlin Coroutines': 'kotlin-coroutines',
    Binder: 'binder',
    IPC: 'ipc',
    AIDL: 'aidl',
    Framework: 'framework',
    AppWidget: 'appwidget',
    'Jetpack Glance': 'jetpack-glance',
    Room: 'room',
    Paging3: 'paging3',
    DataStore: 'datastore',
    SharedPreferences: 'sharedpreferences',
    RecyclerView: 'recyclerview',
    Bitmap: 'bitmap',
    AudioFlinger: 'audioflinger',
    Perfetto: 'perfetto',
    Systrace: 'systrace',
    Gradle: 'gradle',
    'CI/CD': 'ci-cd',
    WebView: 'webview',
    UI: 'ui',
    ViewModel: 'viewmodel',
    Vulkan: 'vulkan',
    WorkManager: 'workmanager',
    WindowInsets: 'windowinsets',
    WindowSizeClass: 'windowsizeclass',
    '性能优化': 'performance',
    '启动优化': 'startup-optimization',
    '冷启动': 'cold-start',
    '内存优化': 'memory-optimization',
    '内存管理': 'memory-management',
    '缓存机制': 'cache',
    '列表优化': 'list-optimization',
    '渲染': 'rendering',
    '图形渲染': 'graphics-rendering',
    '图形栈': 'graphics-stack',
    '音频': 'audio',
    '音频系统': 'audio-system',
    '视频编解码': 'video-codec',
    '多媒体': 'multimedia',
    '架构': 'architecture',
    '架构设计': 'architecture-design',
    '架构解析': 'architecture-analysis',
    '架构模式': 'architecture-patterns',
    '模块化': 'modularization',
    '组件化': 'componentization',
    '工程化': 'engineering',
    '软件工程': 'software-engineering',
    '测试': 'testing',
    '系统服务': 'system-services',
    '系统调试': 'system-debugging',
    '系统适配': 'system-compatibility',
    '进程': 'process',
    '线程': 'thread',
    '进程保活': 'process-keepalive',
    '跨进程通信': 'ipc',
    '权限管理': 'permissions',
    '数据存储': 'data-storage',
    '数据库': 'database',
    '状态管理': 'state-management',
    '响应式编程': 'reactive-programming',
    '协程': 'coroutines',
    '并发编程': 'concurrency',
    '生命周期': 'lifecycle',
    '手势处理': 'gestures',
    '动画': 'animation',
    '动效设计': 'motion-design',
    '声明式': 'declarative-ui',
    '视图桥接': 'view-interop',
    '大屏适配': 'large-screen',
    '折叠屏': 'foldables',
    '配置变更': 'configuration-changes',
    '后台任务': 'background-work',
    '电源管理': 'power-management',
    '热修复': 'hotfix',
    '构建优化': 'build-optimization',
    '编译器': 'compiler',
    '编译器原理': 'compiler-internals',
    '编译': 'compilation',
    '源码分析': 'source-analysis',
    '签名机制': 'app-signing',
    '逆向': 'reverse-engineering',
    '逆向防护': 'app-hardening',
    '隐藏API': 'hidden-api',
    '兼容性': 'compatibility',
    '国际化': 'i18n',
    '多语言': 'localization',
    '动态化': 'dynamic-delivery',
    '动态模块化': 'dynamic-features',
    '路由分发': 'routing',
    '文件系统': 'filesystem',
    '分区存储': 'scoped-storage',
    '网络': 'networking',
    '网络通信': 'network-communication',
    '网络代理': 'network-proxy',
    '协议': 'protocols',
    '后端': 'backend',
    '基础': 'basics',
    '表单': 'forms',
    '端侧推理': 'on-device-inference',
    '本地推理': 'local-inference',
    '大模型': 'large-language-models',
    '大语言模型': 'large-language-models',
    '提示词工程': 'prompt-engineering',
    '前沿技术': 'emerging-tech',
    '开发工具': 'developer-tools',
    '调试工具': 'debugging-tools',
    '开发效率': 'developer-productivity',
    '运维': 'operations',
    '线上运维': 'production-operations',
    '稳定性': 'stability',
    '技术管理': 'engineering-management',
    '领导力': 'leadership',
    '软技能': 'soft-skills',
    '心理学': 'psychology',
    '思维模型': 'mental-models',
    '自我提升': 'self-improvement',
    '搜索引擎': 'search-engine',
    '全文检索': 'full-text-search',
    '创作者经济': 'creator-economy',
    '数据分析': 'data-analysis',
    '无锁数据结构': 'lock-free',
    '布局': 'layout',
    '排版': 'typography',
    '硬解码': 'hardware-decoding',
    '编解码': 'codec',
    '虚拟机': 'virtual-machine'
};

export function getPostHref(post: { id: string; data: { slug?: string } }, locale: Locale = 'zh'): string {
    return getLocalizedPostPath(post, locale);
}

/**
 * 将字符串转换为 URL 友好的 slug。常见中文技术标签使用可读英文别名，
 * 未收录词条保留中文短语，避免生成 u5e03 这类不可读 URL。
 */
export function slugify(input?: string): string {
    if (!input) return '';

    const trimmed = input.trim();
    if (!trimmed) return '';

    const mappedSlug = readableSlugMap[trimmed];
    if (mappedSlug) return mappedSlug;

    // 移除重音符号（针对拉丁字符）
    let slug = trimmed
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    slug = slug.toLowerCase();

    // 检查是否包含非 ASCII 字符（如中文）
    const hasNonAscii = /[^\x00-\x7F]/.test(slug);
    if (hasNonAscii) {
        return slug
            .replace(/[^\p{Letter}\p{Number}\s-]/gu, ' ')
            .trim()
            .replace(/[\s-]+/g, '-')
            .replace(/^-|-$/g, '');
    }

    return slug
        .replace(/[^a-z0-9\s-]/g, ' ')
        .trim()
        .replace(/[\s-]+/g, '-');
}

export function getUniqueSlug(baseSlug: string, usedSlugs: Set<string>) {
    let slug = baseSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
    }
    usedSlugs.add(slug);
    return slug;
}

export function legacySlugify(input?: string): string {
    if (!input) return '';

    const trimmed = input.trim();
    if (!trimmed) return '';

    let slug = trimmed
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    if (/[^\x00-\x7F]/.test(slug)) {
        return slug
            .split('')
            .map((c) =>
                /[a-z0-9-]/.test(c)
                    ? c
                    : Array.from(c)
                          .map((ch) => 'u' + ch.charCodeAt(0).toString(16))
                          .join('')
            )
            .join('-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
    }

    return slug.replace(/[^a-z0-9\s-]/g, ' ').trim().replace(/[\s-]+/g, '-');
}
