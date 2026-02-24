/**
 * 将字符串转换为 URL 友好的 slug，支持中文（非 ASCII 使用 Unicode 编码）
 */
export function slugify(input?: string): string {
    if (!input) return '';

    const trimmed = input.trim();
    if (!trimmed) return '';

    // 移除重音符号（针对拉丁字符）
    let slug = trimmed
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

    // 检查是否包含非 ASCII 字符（如中文）
    const hasNonAscii = /[^\x00-\x7F]/.test(slug);
    if (hasNonAscii) {
        // 中文等非 ASCII：将每个字符转为 U+code 格式，保证唯一且 URL 安全
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
            .replace(/^-|-$/g, '')
            .toLowerCase();
    }

    // 纯 ASCII：原有逻辑
    slug = slug.toLowerCase();
    slug = slug.replace(/[^a-z0-9\s-]/g, ' ').trim();
    slug = slug.replace(/[\s-]+/g, '-');

    return slug;
}
