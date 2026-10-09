import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { BANNER_TIERS, BIG_TRIP_ANGLES } from './home.types.js';
import type { BannerTier, BigTripAngle } from './home.types.js';

/** `src/home/copy/<tier>.<locale>.json` next to this module (copied to dist/ by nest-cli.json). */
export const DEFAULT_COPY_DIR = fileURLToPath(new URL('./copy/', import.meta.url));

export const COPY_PLACEHOLDERS = ['destination', 'country', 'distanceKm', 'daysOff', 'holidayName', 'month', 'tempC', 'persona', 'route'] as const;
export type CopyPlaceholder = (typeof COPY_PLACEHOLDERS)[number];
/** The values a banner can fill in; a template is eligible only when every placeholder it uses is present. */
export type CopyValues = Partial<Record<CopyPlaceholder, string>>;

export const MIN_TEMPLATES = 6;
export const MAX_TEMPLATES = 10;
export const MAX_HEADLINE_WORDS = 6;
export const MAX_SUBLINE_WORDS = 14;

export type CopyTemplate = { headline: string; subline: string; plannerPrompt: string; angle?: BigTripAngle };
export type CopySet = Record<BannerTier, Record<Locale, CopyTemplate[]>>;

const PLACEHOLDER = /\{([a-zA-Z]+)\}/g;
const BANNED_WORDS = /\b(amazing|incredible|incrível|incrivel|increíble|increible)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

export const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

export function placeholdersIn(text: string): CopyPlaceholder[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as CopyPlaceholder);
}

/**
 * The copy rules (docs/app-home-spec.md, Copy rules) a headline and subline must obey, for the
 * curated sets and for AI-generated pairs alike. Returns the problems found (empty = fine).
 */
export function copyProblems(copy: { headline: string; subline: string }): string[] {
  const problems: string[] = [];
  const all = `${copy.headline} ${copy.subline}`;
  if (wordCount(copy.headline) > MAX_HEADLINE_WORDS) problems.push(`headline has more than ${MAX_HEADLINE_WORDS} words`);
  if (wordCount(copy.subline) > MAX_SUBLINE_WORDS) problems.push(`subline has more than ${MAX_SUBLINE_WORDS} words`);
  if (!copy.headline.trim()) problems.push('headline is empty');
  if (!copy.subline.trim()) problems.push('subline is empty');
  if (all.includes('!')) problems.push('exclamation marks are not allowed');
  if (all.includes('...')) problems.push('use the … character, not three dots');
  if (BANNED_WORDS.test(all)) problems.push('"amazing/incredible" are not allowed');
  if (EMOJI.test(all)) problems.push('emoji are not allowed');
  if (/\n/.test(all)) problems.push('line breaks are not allowed');
  return problems;
}

function parseTemplate(raw: unknown, at: string, tier: BannerTier, problems: string[]): CopyTemplate | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const t = raw as Record<string, unknown>;
  const before = problems.length;
  for (const field of ['headline', 'subline', 'plannerPrompt'] as const) {
    if (typeof t[field] !== 'string' || !(t[field] as string).trim()) problems.push(`${at}.${field} must be a non-empty string`);
  }
  if (problems.length > before) return null;
  const template: CopyTemplate = { headline: t.headline as string, subline: t.subline as string, plannerPrompt: t.plannerPrompt as string };
  for (const problem of copyProblems(template)) problems.push(`${at}: ${problem}`);
  for (const field of ['headline', 'subline', 'plannerPrompt'] as const) {
    for (const name of placeholdersIn(template[field])) {
      if (!(COPY_PLACEHOLDERS as readonly string[]).includes(name)) problems.push(`${at}.${field}: unknown placeholder {${name}}`);
    }
  }
  if (!placeholdersIn(`${template.headline} ${template.plannerPrompt}`).some((p) => p === 'destination' || p === 'route')) {
    problems.push(`${at}: the headline or planner prompt must name the place ({destination} or {route})`);
  }
  if (tier === 'bigTrip') {
    if (!(BIG_TRIP_ANGLES as readonly string[]).includes(t.angle as string)) problems.push(`${at}.angle must be one of ${BIG_TRIP_ANGLES.join(', ')}`);
    else template.angle = t.angle as BigTripAngle;
  } else if (t.angle !== undefined) problems.push(`${at}.angle only applies to bigTrip templates`);
  for (const key of Object.keys(t)) if (!['headline', 'subline', 'plannerPrompt', 'angle'].includes(key)) problems.push(`${at}: unknown field "${key}"`);
  return problems.length > before ? null : template;
}

/** Validates one file's content (`{ templates: [...] }`) for a tier; throws one error listing every problem. */
export function parseCopyFile(raw: unknown, tier: BannerTier): CopyTemplate[] {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { templates?: unknown }).templates)) {
    throw new Error('must be a JSON object with a "templates" array');
  }
  const problems: string[] = [];
  const list = (raw as { templates: unknown[] }).templates;
  if (list.length < MIN_TEMPLATES || list.length > MAX_TEMPLATES) problems.push(`needs ${MIN_TEMPLATES}-${MAX_TEMPLATES} templates (has ${list.length})`);
  const templates: CopyTemplate[] = [];
  list.forEach((entry, i) => {
    const template = parseTemplate(entry, `templates[${i}]`, tier, problems);
    if (template) templates.push(template);
  });
  if (tier === 'bigTrip' && problems.length === 0) {
    for (const angle of BIG_TRIP_ANGLES) if (!templates.some((t) => t.angle === angle)) problems.push(`no template for the ${angle} angle`);
  }
  if (problems.length > 0) throw new Error(problems.join('; '));
  return templates;
}

/** Loads and validates every `<tier>.<locale>.json`; the error names the file and every problem. */
export function loadCopy(dir: string = DEFAULT_COPY_DIR): CopySet {
  const set = {} as CopySet;
  for (const tier of BANNER_TIERS) {
    set[tier] = {} as Record<Locale, CopyTemplate[]>;
    for (const locale of SUPPORTED_LOCALES) {
      const path = `${dir}${tier}.${locale}.json`;
      try {
        set[tier][locale] = parseCopyFile(JSON.parse(readFileSync(path, 'utf8')), tier);
      } catch (error) {
        throw new Error(`Invalid home copy set (${path}): ${(error as Error).message}`);
      }
    }
  }
  return set;
}

/** True when every placeholder the template uses has a value. */
export function isEligible(template: CopyTemplate, values: CopyValues): boolean {
  return placeholdersIn(`${template.headline} ${template.subline} ${template.plannerPrompt}`).every((p) => values[p] !== undefined);
}

/** Fills the placeholders (all present) and capitalizes the first letter (a month or a country may start it). */
export function fill(text: string, values: CopyValues): string {
  const filled = text.replace(PLACEHOLDER, (_m, name: CopyPlaceholder) => values[name] ?? '');
  return filled.charAt(0).toLocaleUpperCase() + filled.slice(1);
}

export const EYEBROWS: Record<BannerTier, Record<Locale, string>> = {
  nearby: { en: 'Next 15 days', 'pt-BR': 'Próximos 15 dias', es: 'Próximos 15 días' },
  longWeekend: { en: 'Long weekend', 'pt-BR': 'Feriado prolongado', es: 'Fin de semana largo' },
  bigTrip: { en: 'The big one', 'pt-BR': 'A grande viagem', es: 'El gran viaje' },
  trending: { en: 'Trending now', 'pt-BR': 'Em alta agora', es: 'Tendencia ahora' },
};

export const CTA: Record<Locale, string> = { en: 'Start planning', 'pt-BR': 'Começar a planejar', es: 'Empezar a planear' };

/**
 * What `{persona}` reads as: a noun phrase that fits "your kind of {persona}" / "tempo para {persona}" /
 * "tiempo para {persona}", by persona key (`wizard/questions.json`).
 */
export const PERSONA_PHRASES: Record<string, Record<Locale, string>> = {
  relaxer: { en: 'slow mornings', 'pt-BR': 'manhãs sem pressa', es: 'mañanas sin prisa' },
  explorer: { en: 'side streets', 'pt-BR': 'ruas escondidas', es: 'calles escondidas' },
  foodie: { en: 'market lunches', 'pt-BR': 'almoços de mercado', es: 'almuerzos de mercado' },
  adventurer: { en: 'ridge walks', 'pt-BR': 'trilhas com vista', es: 'senderos con vista' },
};

/** Country names that take an article where the copy puts them after "in"/"conoce"/"para". */
const EN_THE = new Set(['NL', 'US', 'GB', 'AE', 'MV', 'DO', 'PH', 'BS']);
const ES_ARTICLE: Record<string, string> = { GB: 'el', NL: 'los', MV: 'las', AE: 'los', US: 'los' };
const PT_ARTICLE: Record<string, string> = {
  BR: 'o', AR: 'a', US: 'os', PE: 'o', MX: 'o', CL: 'o', UY: 'o', BO: 'a', CO: 'a', EC: 'o', PA: 'o', ES: 'a', FR: 'a', IT: 'a',
  GB: 'o', NL: 'os', DE: 'a', GR: 'a', CZ: 'a', HR: 'a', TR: 'a', CH: 'a', IS: 'a', MA: 'o', ZA: 'a', AE: 'os', MV: 'as', JP: 'o',
  TH: 'a', ID: 'a', AU: 'a', DO: 'a',
};

const displayNames = new Map<Locale, Intl.DisplayNames>();
/** The country's name in `locale`, with its article where the language needs one ("the Netherlands", "o Brasil", "el Reino Unido"). */
export function countryName(code: string, locale: Locale): string {
  let names = displayNames.get(locale);
  if (!names) {
    names = new Intl.DisplayNames(locale, { type: 'region' });
    displayNames.set(locale, names);
  }
  const name = names.of(code) ?? code;
  if (locale === 'en') return EN_THE.has(code) ? `the ${name}` : name;
  if (locale === 'es') return ES_ARTICLE[code] ? `${ES_ARTICLE[code]} ${name}` : name;
  return PT_ARTICLE[code] ? `${PT_ARTICLE[code]} ${name}` : name;
}

/** The month's name in `locale` (lower case in pt-BR and es, as Intl gives it). */
export function monthName(month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, month - 1, 15)));
}

const AND: Record<Locale, string> = { en: 'and', 'pt-BR': 'e', es: 'y' };
/** "Porto, Lisbon and Sintra". */
export function routeText(names: string[], locale: Locale): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${AND[locale]} ${names[names.length - 1]}`;
}
