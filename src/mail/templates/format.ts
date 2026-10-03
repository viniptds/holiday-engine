import type { Locale } from '../../app-common/locale.js';

const utc = (date: string | Date) => (typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : date);

/** A trip's dates for the locale, e.g. "6 – 15 de nov. de 2026" (pt-BR) or "Nov 6 – 15, 2026" (en). */
export function formatDateRange(locale: Locale, start: string, end: string): string {
  const format = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return start === end ? format.format(utc(start)) : format.formatRange(utc(start), utc(end));
}

/** A day in long form, e.g. "10 de outubro de 2026" (UTC). */
export function formatLongDate(locale: Locale, date: Date): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}
