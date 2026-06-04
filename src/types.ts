export type ImageInput = {
    src: ImageMetadata | string;
    alt?: string;
    caption?: string;
};

export type Link = {
    text: string;
    href: string;
};

export type Locale = 'zh' | 'en';

export type LocaleConfig = {
    locale: Locale;
    code: string;
    label: string;
    pathPrefix: string;
};

export type Hero = {
    title?: string;
    text?: string;
    image?: ImageInput;
    actions?: Link[];
};

export type SubscribeForm = {
    action: string;
    emailFieldName?: string;
    hiddenFields?: { name: string; value: string }[];
    honeypotFieldName?: string;
};

export type Subscribe = {
    enabled?: boolean;
    title?: string;
    text?: string;
    form?: SubscribeForm;
};

export type TopicLink = Link & {
    description: string;
};

export type SiteLocaleConfig = {
    title: string;
    subtitle?: string;
    description: string;
    image?: ImageInput;
    headerNavLinks?: Link[];
    footerNavLinks?: Link[];
    socialLinks?: Link[];
    hero?: Hero;
    subscribe?: Subscribe;
    topics?: TopicLink[];
};

export type SiteConfig = SiteLocaleConfig & {
    website: string;
    avatar?: ImageInput;
    postsPerPage?: number;
    projectsPerPage?: number;
    locales: Record<Locale, SiteLocaleConfig>;
};
