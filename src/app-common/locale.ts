import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Languages the app and its emails support. `en` is the fallback. */
export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'es'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Maps any language tag to a supported locale by its primary language (`pt-PT` → `pt-BR`, `es-MX` → `es`). */
export function matchLocale(tag: string | undefined | null): Locale | null {
  const primary = tag?.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === 'en') return 'en';
  if (primary === 'pt') return 'pt-BR';
  if (primary === 'es') return 'es';
  return null;
}

/** Picks the best supported locale from an `Accept-Language` header (q-values respected), else `en`. */
export function resolveLocale(acceptLanguage: string | undefined | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(',')
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const { tag } of ranked) {
    const locale = matchLocale(tag);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

/** The request's locale, from `Accept-Language`. The app sends its current UI language there. */
export const RequestLocale = createParamDecorator((_data: unknown, context: ExecutionContext): Locale => {
  const request = context.switchToHttp().getRequest<{ headers: Record<string, string | string[] | undefined> }>();
  const header = request.headers['accept-language'];
  return resolveLocale(Array.isArray(header) ? header.join(',') : header);
});
