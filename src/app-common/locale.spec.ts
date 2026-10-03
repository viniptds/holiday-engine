import { matchLocale, resolveLocale } from './locale.js';

describe('matchLocale', () => {
  it.each([
    ['en', 'en'],
    ['en-GB', 'en'],
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['pt_br', 'pt-BR'],
    ['es-MX', 'es'],
    ['ES', 'es'],
  ])('maps %s to %s', (tag, locale) => {
    expect(matchLocale(tag)).toBe(locale);
  });

  it.each([['fr'], [''], [undefined], [null]])('returns null for %s', (tag) => {
    expect(matchLocale(tag)).toBeNull();
  });
});

describe('resolveLocale', () => {
  it('defaults to en without a header', () => {
    expect(resolveLocale(undefined)).toBe('en');
    expect(resolveLocale('')).toBe('en');
  });

  it('takes the first supported language in header order', () => {
    expect(resolveLocale('pt-BR,pt;q=0.9,en;q=0.8')).toBe('pt-BR');
    expect(resolveLocale('fr-FR, es;q=0.7, en;q=0.5')).toBe('es');
  });

  it('respects q-values over order', () => {
    expect(resolveLocale('en;q=0.3, es;q=0.9')).toBe('es');
  });

  it('ignores q=0 and falls back to en for unsupported languages', () => {
    expect(resolveLocale('es;q=0, fr')).toBe('en');
    expect(resolveLocale('de-DE,fr;q=0.8')).toBe('en');
  });
});
