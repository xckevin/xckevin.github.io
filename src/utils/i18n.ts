import siteConfig from '../data/site-config';
import type { Locale, LocaleConfig } from '../types';

export const defaultLocale: Locale = 'zh';
export const supportedLocales: Locale[] = ['zh', 'en'];

export const localeConfigs: Record<Locale, LocaleConfig> = {
    zh: {
        locale: 'zh',
        code: 'zh-CN',
        label: '中文',
        pathPrefix: ''
    },
    en: {
        locale: 'en',
        code: 'en',
        label: 'English',
        pathPrefix: '/en'
    }
};

export function getLocaleFromPathname(pathname: string): Locale {
    return pathname === '/en' || pathname.startsWith('/en/') ? 'en' : defaultLocale;
}

export function stripLocalePrefix(pathname: string): string {
    if (pathname === '/en') return '/';
    if (pathname.startsWith('/en/')) return pathname.slice('/en'.length) || '/';
    return pathname || '/';
}

export function withLocalePrefix(pathname: string, locale: Locale): string {
    const cleanPath = stripLocalePrefix(pathname);
    if (locale === defaultLocale) return cleanPath;
    if (cleanPath === '/') return `${localeConfigs[locale].pathPrefix}/`;
    return `${localeConfigs[locale].pathPrefix}${cleanPath}`;
}

export function getLocalizedPath(pathname: string, locale: Locale): string {
    return withLocalePrefix(pathname, locale);
}

export function getLocaleHome(locale: Locale): string {
    return locale === defaultLocale ? '/' : `${localeConfigs[locale].pathPrefix}/`;
}

export function getAlternateLocale(locale: Locale): Locale {
    return locale === 'zh' ? 'en' : 'zh';
}

export function getAbsoluteUrl(pathname: string): string {
    return new URL(pathname, siteConfig.website).toString();
}

export function normalizeTrailingSlash(pathname: string): string {
    const hasQueryParams = pathname.includes('?');
    if (hasQueryParams) return pathname.replace(/\/?$/, '');
    return pathname.replace(/\/?$/, '/');
}

export function getLocalizedPostPath(post: { id: string; data: { slug?: string } }, locale: Locale): string {
    return withLocalePrefix(`/blog/${post.data.slug ?? post.id}/`, locale);
}
