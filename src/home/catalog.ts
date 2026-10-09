import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { normalizeName } from '../ai/draft.js';
import { CATALOG_TAGS, DESTINATION_KINDS } from './home.types.js';
import type { Destination } from './home.types.js';

/** The bundled catalog, next to this module (nest-cli.json copies it to dist/). */
export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('./destinations.json', import.meta.url));

export const MIN_CATALOG_SIZE = 20;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);

/** Great-circle distance in km (haversine), whole km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)));
}

function parseDestination(raw: unknown, at: string, problems: string[]): Destination | null {
  if (!isObject(raw)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const where = isText(raw.id) ? `destination "${raw.id}"` : at;
  const before = problems.length;
  if (!isText(raw.id) || !/^[a-z0-9-]+$/.test(raw.id)) problems.push(`${at}.id must be a lower-case slug`);
  if (!isObject(raw.names)) problems.push(`${where}: names must be an object with a name per locale`);
  else {
    for (const locale of SUPPORTED_LOCALES) if (!isText(raw.names[locale])) problems.push(`${where}: names is missing "${locale}"`);
    for (const key of Object.keys(raw.names)) if (!(SUPPORTED_LOCALES as readonly string[]).includes(key)) problems.push(`${where}: names has unsupported locale "${key}"`);
  }
  if (!isText(raw.country) || !/^[A-Z]{2}$/.test(raw.country)) problems.push(`${where}: country must be an ISO 3166-1 alpha-2 code`);
  if (!isStringList(raw.aliases) || raw.aliases.length === 0) problems.push(`${where}: aliases must be a non-empty array of strings`);
  if (!isStringList(raw.tags) || raw.tags.length === 0) problems.push(`${where}: tags must be a non-empty array of strings`);
  else for (const tag of raw.tags) if (!(CATALOG_TAGS as readonly string[]).includes(tag)) problems.push(`${where}: unknown tag "${tag}"`);
  if (!Array.isArray(raw.bestMonths) || raw.bestMonths.length === 0 || !raw.bestMonths.every((m) => Number.isInteger(m) && m >= 1 && m <= 12)) {
    problems.push(`${where}: bestMonths must be a non-empty array of months 1-12`);
  }
  if (!isStringList(raw.similar)) problems.push(`${where}: similar must be an array of destination ids`);
  if (!Number.isInteger(raw.popularity) || (raw.popularity as number) < 1 || (raw.popularity as number) > 5) problems.push(`${where}: popularity must be 1-5`);
  if (typeof raw.lat !== 'number' || raw.lat < -90 || raw.lat > 90) problems.push(`${where}: lat must be a number between -90 and 90`);
  if (typeof raw.lng !== 'number' || raw.lng < -180 || raw.lng > 180) problems.push(`${where}: lng must be a number between -180 and 180`);
  if (!(DESTINATION_KINDS as readonly string[]).includes(raw.kind as string)) problems.push(`${where}: kind must be one of ${DESTINATION_KINDS.join(', ')}`);
  if (problems.length > before) return null;
  return {
    id: raw.id as string,
    names: Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, (raw.names as Record<string, string>)[l]])) as Record<Locale, string>,
    country: raw.country as string,
    aliases: (raw.aliases as string[]).map(normalizeName),
    tags: [...(raw.tags as Destination['tags'])],
    bestMonths: [...(raw.bestMonths as number[])],
    similar: [...(raw.similar as string[])],
    popularity: raw.popularity as number,
    lat: raw.lat as number,
    lng: raw.lng as number,
    kind: raw.kind as Destination['kind'],
  };
}

/** Checks a parsed catalog (`{ destinations: [...] }`) and returns a clean copy; throws one error listing every problem. */
export function parseCatalog(raw: unknown): Destination[] {
  if (!isObject(raw) || !Array.isArray(raw.destinations)) throw new Error('the catalog must be a JSON object with a "destinations" array');
  const problems: string[] = [];
  const destinations: Destination[] = [];
  raw.destinations.forEach((entry: unknown, i) => {
    const destination = parseDestination(entry, `destinations[${i}]`, problems);
    if (destination) destinations.push(destination);
  });
  const ids = new Set<string>();
  for (const d of destinations) {
    if (ids.has(d.id)) problems.push(`destination id "${d.id}" is used more than once`);
    ids.add(d.id);
  }
  for (const d of destinations) {
    for (const s of d.similar) if (!ids.has(s)) problems.push(`destination "${d.id}": similar "${s}" is not in the catalog`);
    if (d.similar.includes(d.id)) problems.push(`destination "${d.id}" lists itself as similar`);
  }
  if (problems.length === 0 && destinations.length < MIN_CATALOG_SIZE) problems.push(`the catalog needs at least ${MIN_CATALOG_SIZE} destinations (has ${destinations.length})`);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return destinations;
}

/** Reads, parses and validates the catalog file; the error names the file and every problem. */
export function loadCatalog(path: string = DEFAULT_CATALOG_PATH): DestinationCatalog {
  try {
    return new DestinationCatalog(parseCatalog(JSON.parse(readFileSync(path, 'utf8'))));
  } catch (error) {
    throw new Error(`Invalid destination catalog (${path}): ${(error as Error).message}`);
  }
}

/** The validated catalog with lookups by id, by alias (free-text destinations) and by distance. */
export class DestinationCatalog {
  private readonly byId = new Map<string, Destination>();
  private readonly byAlias = new Map<string, Destination>();

  constructor(readonly destinations: Destination[]) {
    for (const d of destinations) {
      this.byId.set(d.id, d);
      for (const alias of d.aliases) this.byAlias.set(alias, d);
      for (const name of Object.values(d.names)) this.byAlias.set(normalizeName(name), d);
    }
  }

  get(id: string): Destination | undefined {
    return this.byId.get(id);
  }

  /** The entry a free-text destination names ("Porto, Portugal", "Río de Janeiro"), or undefined. */
  match(text: string | null | undefined): Destination | undefined {
    if (!text) return undefined;
    const whole = normalizeName(text);
    const direct = this.byAlias.get(whole);
    if (direct) return direct;
    // "Porto, Portugal" / "Porto - PT": the first comma or dash separated part.
    const head = normalizeName(text.split(/[,\-–/(]/)[0]);
    return this.byAlias.get(head);
  }

  /** The nearest entry to a position within `maxKm`, or undefined. */
  nearest(position: { lat: number; lng: number }, maxKm: number): { destination: Destination; distanceKm: number } | undefined {
    let best: { destination: Destination; distanceKm: number } | undefined;
    for (const destination of this.destinations) {
      const km = distanceKm(position, destination);
      if (km <= maxKm && (!best || km < best.distanceKm)) best = { destination, distanceKm: km };
    }
    return best;
  }
}
