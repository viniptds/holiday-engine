import { Inject, Injectable, Logger } from '@nestjs/common';
import { TtlLru } from '../app-common/ttl-lru.js';
import type { FetchFn } from '../ai/llm/http-json.js';
import { HOLIDAYS_CACHE_SIZE, HOLIDAYS_TTL_MS, HOME_FETCH, HOME_FETCH_TIMEOUT_MS, NAGER_HOLIDAYS_URL } from './home.types.js';
import type { PublicHoliday } from './home.types.js';

type NagerHoliday = { date?: string; localName?: string; name?: string; global?: boolean; counties?: string[] | null; types?: string[] };

/** Nager.Date's list → nationwide public holidays, sorted by date. */
export function parseHolidays(body: unknown): PublicHoliday[] | null {
  if (!Array.isArray(body)) return null;
  return (body as NagerHoliday[])
    .filter((h) => typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date) && typeof h.name === 'string')
    .filter((h) => h.global !== false || !h.counties?.length)
    .filter((h) => !h.types || h.types.includes('Public'))
    .map((h) => ({ date: h.date!, name: h.name!, localName: typeof h.localName === 'string' && h.localName ? h.localName : h.name! }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Public holidays from Nager.Date (free, no key), cached 7 days per country and year. A failure gives [] (and isn't cached). */
@Injectable()
export class HolidaysService {
  private readonly logger = new Logger(HolidaysService.name);
  private readonly cache = new TtlLru<string, PublicHoliday[]>(HOLIDAYS_CACHE_SIZE, HOLIDAYS_TTL_MS);

  constructor(@Inject(HOME_FETCH) private readonly fetchFn: FetchFn) {}

  reset(): void {
    this.cache.clear();
  }

  async forYear(countryCode: string, year: number): Promise<PublicHoliday[]> {
    const country = countryCode.toUpperCase();
    if (!/^[A-Z]{2}$/.test(country)) return [];
    const key = `${country}:${year}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    try {
      const response = await this.fetchFn(`${NAGER_HOLIDAYS_URL}/${year}/${country}`, { signal: AbortSignal.timeout(HOME_FETCH_TIMEOUT_MS) });
      // 204: a country Nager knows but has no data for; 404: unknown country. Both mean "no holidays".
      if (response.status === 204 || response.status === 404) {
        this.cache.set(key, []);
        return [];
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const holidays = parseHolidays(await response.json());
      if (!holidays) throw new Error('unexpected response shape');
      this.cache.set(key, holidays);
      return holidays;
    } catch (error) {
      this.logger.warn(`Holidays: lookup failed for ${country}/${year} (${(error as Error).message})`);
      return [];
    }
  }

  /** Holidays from `from` (inclusive) for the next `days` days, across the year boundary. */
  async upcoming(countryCode: string, from: Date, days: number): Promise<PublicHoliday[]> {
    const start = from.toISOString().slice(0, 10);
    const end = new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
    const years = [...new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])];
    const lists = await Promise.all(years.map((year) => this.forYear(countryCode, year)));
    return lists
      .flat()
      .filter((h) => h.date >= start && h.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}
