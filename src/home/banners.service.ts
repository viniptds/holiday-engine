import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Repository } from 'typeorm';
import type { AuthUser } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { TtlLru } from '../app-common/ttl-lru.js';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { PartyType } from '../app-trips/app-trips.types.js';
import { UsersService } from '../users/users.service.js';
import { MediaService } from '../media/media.service.js';
import { WizardService } from '../wizard/wizard.service.js';
import { DestinationCatalog, distanceKm } from './catalog.js';
import { CTA, EYEBROWS, PERSONA_PHRASES, countryName, fill, isEligible, monthName, routeText } from './copy.js';
import type { CopySet, CopyTemplate, CopyValues } from './copy.js';
import { HomeCopy } from './home-copy.entity.js';
import {
  BANNERS_CACHE_SIZE,
  BANNERS_TTL_MS,
  BIG_TRIP_ANGLES,
  BIG_TRIP_HORIZONS,
  BIG_TRIP_MIN_KM,
  CATALOG_TAGS,
  DESTINATION_CATALOG,
  HOLIDAY_LOOKAHEAD_DAYS,
  HOME_COPY,
  LONG_WEEKEND_MAX_KM,
  LONG_WEEKEND_MIN_KM,
  MAX_COUNTRY_REPEATS,
  NEARBY_EXCLUSION_DAYS,
  NEARBY_MAX_KM,
  OWN_CITY_KM,
} from './home.types.js';
import type { BannerAngle, BannerDto, BannerFacts, BannerTier, BannersDto, BigTripAngle, CatalogTag, Destination, PublicHoliday } from './home.types.js';
import { HolidaysService } from './holidays.service.js';
import { TrendingService } from './trending.service.js';
import { WeatherService } from './weather.service.js';

const DAY_MS = 86_400_000;
/** The country a position is in, guessed from the nearest catalog entry (no reverse geocoder without a key). */
const COUNTRY_GUESS_KM = 300;
/** How many top-scored candidates the seeded pick chooses among (so sets differ between users). */
const PICK_AMONG = 3;
const PERSONA_TAGS: Record<string, CatalogTag[]> = { relaxer: ['relax', 'beach'], explorer: ['culture', 'city'], foodie: ['food'], adventurer: ['nature', 'adventure'] };

export type Position = { lat: number; lng: number };

/** A seeded PRNG (mulberry32) so a user's banners are stable within an ISO week. */
export function seededRandom(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `2026-W41`. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * The days off a public holiday gives with the adjacent weekend: Monday or Friday → 3 (no leave),
 * Tuesday or Thursday → 4 (one bridge day). A weekend holiday gives none.
 */
export function longWeekendDays(isoDate: string): number | null {
  const weekday = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  if (weekday === 1 || weekday === 5) return 3;
  if (weekday === 2 || weekday === 4) return 4;
  return null;
}

/**
 * The big-trip horizon: 3 months, unless a trip already starts within 3 months (then 6), and 12
 * when one also starts between 3 and 6 months out.
 */
export function bigTripHorizon(tripStarts: string[], today: string): (typeof BIG_TRIP_HORIZONS)[number] {
  const monthsAway = (start: string) => (new Date(`${start}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / (30.4 * DAY_MS);
  const future = tripStarts.map(monthsAway).filter((m) => m >= 0);
  if (!future.some((m) => m <= 3)) return 3;
  return future.some((m) => m > 3 && m <= 6) ? 12 : 6;
}

/** Season fit (+3 in a best month), interest and persona tag overlap (+1 each) and a mild popularity tie-breaker. */
export function scoreDestination(d: Destination, month: number, tags: Set<CatalogTag>): number {
  const season = d.bestMonths.includes(month) ? 3 : 0;
  const overlap = d.tags.filter((t) => tags.has(t)).length;
  return season + overlap + d.popularity * 0.2;
}

type Signals = {
  position: Position | null;
  ownCity: Destination | null;
  country: string | null;
  trips: Trip[];
  persona: string | null;
  tags: Set<CatalogTag>;
  partyType: PartyType | null;
};

type Pick = { destination: Destination; score: number; distanceKm?: number };

/**
 * Trip-idea banners (docs/app-home-spec.md): four tiers chosen by deterministic catalog rules,
 * seeded by user and ISO week, with curated (or AI-refreshed) copy. No model calls per request;
 * everything comes from cached inputs. Cached per user for an hour.
 */
@Injectable()
export class BannersService {
  private readonly logger = new Logger(BannersService.name);
  private readonly cache = new TtlLru<string, BannersDto>(BANNERS_CACHE_SIZE, BANNERS_TTL_MS);
  /** (destination, tier, locale, angle) combinations served in the last day: what the nightly refresh writes copy for. */
  private readonly served = new TtlLru<string, { destinationId: string; tier: BannerTier; locale: Locale; angle: string }>(5_000, 24 * 60 * 60 * 1000);
  /** Tests override this. */
  now: () => Date = () => new Date();

  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @InjectRepository(HomeCopy) private readonly homeCopy: Repository<HomeCopy>,
    @Inject(DESTINATION_CATALOG) private readonly catalog: DestinationCatalog,
    @Inject(HOME_COPY) private readonly copy: CopySet,
    private readonly wizard: WizardService,
    private readonly users: UsersService,
    private readonly media: MediaService,
    private readonly weather: WeatherService,
    private readonly holidays: HolidaysService,
    private readonly trending: TrendingService,
  ) {}

  resetCache(): void {
    this.cache.clear();
  }

  recentlyServed(): { destinationId: string; tier: BannerTier; locale: Locale; angle: string }[] {
    return this.served.values();
  }

  async banners(user: AuthUser, locale: Locale, position: Position | null, localeRegion: string | null): Promise<BannersDto> {
    const key = `${user.id}|${locale}|${position ? `${position.lat},${position.lng}` : '-'}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const now = this.now();
    const signals = await this.signals(user, position, localeRegion);
    const rng = seededRandom(`${user.id}:${isoWeek(now)}`);
    const used = new Set<string>();
    const countries = new Map<string, number>();
    const banners: BannerDto[] = [];
    const take = async (tier: BannerTier, choose: () => Promise<BannerDto | null>) => {
      try {
        const banner = await choose();
        if (!banner) return;
        banners.push(banner);
        used.add(banner.destinationId);
        countries.set(banner.country, (countries.get(banner.country) ?? 0) + 1);
      } catch (error) {
        this.logger.warn(`Banners: ${tier} tier skipped (${(error as Error).name})`);
      }
    };
    const allowed = (d: Destination) => !used.has(d.id) && (countries.get(d.country) ?? 0) < MAX_COUNTRY_REPEATS;

    await take('nearby', () => this.nearby(signals, locale, now, rng, allowed));
    await take('longWeekend', () => this.longWeekend(signals, locale, now, rng, allowed));
    await take('bigTrip', () => this.bigTrip(signals, locale, now, rng, allowed));
    await take('trending', () => this.trendingBanner(signals, locale, now, rng, allowed));

    const result = { banners, generatedAt: now.toISOString() };
    this.cache.set(key, result);
    return result;
  }

  // --- signals -------------------------------------------------------------------------------

  private async signals(user: AuthUser, query: Position | null, localeRegion: string | null): Promise<Signals> {
    const [account, memberships] = await Promise.all([this.users.findActive(user.id), this.members.find({ where: { userId: user.id }, relations: { trip: true } })]);
    const trips = memberships.map((m) => m.trip).filter((t): t is Trip => !!t);
    const homeCity = this.catalog.match(account?.homeCity) ?? null;
    const position = query ?? (homeCity ? { lat: homeCity.lat, lng: homeCity.lng } : null);
    const ownCity = (query ? this.catalog.nearest(query, OWN_CITY_KM)?.destination : homeCity) ?? homeCity;
    const nearestCountry = position ? this.catalog.nearest(position, COUNTRY_GUESS_KM)?.destination.country : undefined;
    const country = nearestCountry ?? homeCity?.country ?? (localeRegion && /^[A-Za-z]{2}$/.test(localeRegion) ? localeRegion.toUpperCase() : null);

    const latest = [...trips].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const tags = new Set<CatalogTag>();
    let persona: string | null = null;
    for (const trip of latest) {
      const profile = trip.travelerProfile;
      if (!profile) continue;
      if (!persona && profile.persona) persona = this.wizard.normalizeProfile(profile)?.persona ?? null;
      for (const option of profile.answers?.interests ?? []) if ((CATALOG_TAGS as readonly string[]).includes(option)) tags.add(option as CatalogTag);
    }
    if (persona) for (const tag of PERSONA_TAGS[persona] ?? []) tags.add(tag);
    const partyType = latest.find((t) => t.partyType)?.partyType ?? null;
    return { position, ownCity, country, trips, persona, tags, partyType };
  }

  // --- tiers ---------------------------------------------------------------------------------

  private async nearby(s: Signals, locale: Locale, now: Date, rng: () => number, allowed: (d: Destination) => boolean): Promise<BannerDto | null> {
    if (!s.position) return null;
    const position = s.position;
    const today = now.toISOString().slice(0, 10);
    const horizon = new Date(now.getTime() + NEARBY_EXCLUSION_DAYS * DAY_MS).toISOString().slice(0, 10);
    const planned = new Set(s.trips.filter((t) => t.startDate >= today && t.startDate <= horizon).map((t) => this.catalog.match(t.destination)?.id).filter(Boolean));
    const month = now.getUTCMonth() + 1;
    const candidates: Pick[] = [];
    for (const d of this.catalog.destinations) {
      if (!allowed(d) || d.id === s.ownCity?.id || planned.has(d.id)) continue;
      const km = distanceKm(position, d);
      if (km > NEARBY_MAX_KM) continue;
      candidates.push({ destination: d, distanceKm: km, score: scoreDestination(d, month, s.tags) - km / NEARBY_MAX_KM });
    }
    const pick = this.choose(candidates, rng);
    if (!pick) return null;
    const tempC = await this.weather.currentTempC(pick.destination);
    const facts: BannerFacts = { distanceKm: pick.distanceKm, tempC };
    if (pick.destination.bestMonths.includes(month)) facts.month = monthName(month, locale);
    return this.build('nearby', pick.destination, locale, facts, s, rng);
  }

  private async longWeekend(s: Signals, locale: Locale, now: Date, rng: () => number, allowed: (d: Destination) => boolean): Promise<BannerDto | null> {
    if (!s.position) return null;
    const position = s.position;
    let holiday: PublicHoliday | null = null;
    let daysOff = 3;
    let date: Date;
    const upcoming = s.country ? await this.holidays.upcoming(s.country, now, HOLIDAY_LOOKAHEAD_DAYS) : [];
    const block = upcoming.map((h) => ({ h, days: longWeekendDays(h.date) })).find((x) => x.days !== null);
    if (block) {
      holiday = block.h;
      daysOff = block.days!;
      date = new Date(`${holiday.date}T00:00:00Z`);
    } else {
      // No holiday ahead: the next weekend with Friday taken off.
      const daysToFriday = (5 - now.getUTCDay() + 7) % 7 || 7;
      date = new Date(now.getTime() + daysToFriday * DAY_MS);
    }
    const month = date.getUTCMonth() + 1;
    const candidates: Pick[] = [];
    for (const d of this.catalog.destinations) {
      if (!allowed(d) || d.id === s.ownCity?.id) continue;
      const km = distanceKm(position, d);
      if (km < LONG_WEEKEND_MIN_KM || km > LONG_WEEKEND_MAX_KM) continue;
      candidates.push({ destination: d, distanceKm: km, score: scoreDestination(d, month, s.tags) });
    }
    const pick = this.choose(candidates, rng);
    if (!pick) return null;
    const facts: BannerFacts = { distanceKm: pick.distanceKm, daysOff, month: monthName(month, locale) };
    if (holiday) facts.holidayName = holiday.localName;
    return this.build('longWeekend', pick.destination, locale, facts, s, rng);
  }

  private async bigTrip(s: Signals, locale: Locale, now: Date, rng: () => number, allowed: (d: Destination) => boolean): Promise<BannerDto | null> {
    const today = now.toISOString().slice(0, 10);
    const horizon = bigTripHorizon(s.trips.map((t) => t.startDate), today);
    const month = ((now.getUTCMonth() + horizon) % 12) + 1;
    const candidates: Pick[] = [];
    for (const d of this.catalog.destinations) {
      if (!allowed(d) || d.id === s.ownCity?.id) continue;
      if (s.position && distanceKm(s.position, d) <= BIG_TRIP_MIN_KM) continue;
      candidates.push({ destination: d, score: scoreDestination(d, month, s.tags) });
    }
    const pick = this.choose(candidates, rng);
    if (!pick) return null;
    const destination = pick.destination;
    const facts: BannerFacts = { month: monthName(month, locale) };
    const base = this.values(destination, locale, facts, s);
    // The explorer route: the destination plus up to two similar places, same country first, else the region.
    const similar = destination.similar.map((id) => this.catalog.get(id)).filter((d): d is Destination => !!d);
    const sameCountry = similar.filter((d) => d.country === destination.country);
    const route = [destination, ...(sameCountry.length > 0 ? sameCountry : similar).slice(0, 2)];
    const routeValue = route.length > 1 ? routeText(route.map((d) => d.names[locale]), locale) : undefined;

    const first: BigTripAngle = s.partyType === 'family' ? 'family' : s.partyType === 'work' ? 'business' : 'explorer';
    const order = [first, ...BIG_TRIP_ANGLES.filter((a) => a !== first)];
    const ai = await this.aiCopy(destination.id, 'bigTrip', locale, now);
    const angles: BannerAngle[] = [];
    for (const angle of order) {
      const values: CopyValues = angle === 'explorer' && routeValue ? { ...base, route: routeValue } : base;
      const template = this.template('bigTrip', locale, values, rng, angle);
      if (!template) continue;
      const copy = this.render(template, values, ai.get(angle), rng);
      angles.push({ key: angle, ...copy });
      this.remember(destination.id, 'bigTrip', locale, angle);
    }
    if (angles.length === 0) return null;
    const photo = await this.photo(destination);
    return {
      tier: 'bigTrip',
      destinationId: destination.id,
      name: destination.names[locale],
      country: destination.country,
      eyebrow: EYEBROWS.bigTrip[locale],
      headline: angles[0].headline,
      subline: angles[0].subline,
      cta: CTA[locale],
      photo,
      plannerPrompt: angles[0].plannerPrompt,
      angles,
      facts,
    };
  }

  private async trendingBanner(s: Signals, locale: Locale, now: Date, rng: () => number, allowed: (d: Destination) => boolean): Promise<BannerDto | null> {
    const entries = (await this.trending.list()).filter((e) => allowed(e.destination) && e.destination.id !== s.ownCity?.id);
    if (entries.length === 0) return null;
    const pick = entries[Math.floor(rng() * Math.min(PICK_AMONG, entries.length))];
    const current = now.getUTCMonth() + 1;
    // The next of its best months (this one included), so "good in {month}" is true.
    const next = [...pick.destination.bestMonths].sort((a, b) => ((a - current + 12) % 12) - ((b - current + 12) % 12))[0];
    const facts: BannerFacts = { month: monthName(next, locale) };
    return this.build('trending', pick.destination, locale, facts, s, rng);
  }

  // --- helpers -------------------------------------------------------------------------------

  /** The best-scored candidates, one of the top few chosen by the seed (ties broken by id, so it's deterministic). */
  private choose(candidates: Pick[], rng: () => number): Pick | null {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => b.score - a.score || a.destination.id.localeCompare(b.destination.id));
    return sorted[Math.floor(rng() * Math.min(PICK_AMONG, sorted.length))];
  }

  private values(destination: Destination, locale: Locale, facts: BannerFacts, s: Signals): CopyValues {
    const values: CopyValues = { destination: destination.names[locale], country: countryName(destination.country, locale) };
    if (facts.distanceKm !== undefined) values.distanceKm = String(facts.distanceKm);
    if (facts.daysOff !== undefined) values.daysOff = String(facts.daysOff);
    if (facts.holidayName !== undefined) values.holidayName = facts.holidayName;
    if (facts.month !== undefined) values.month = facts.month;
    if (facts.tempC !== undefined) values.tempC = String(facts.tempC);
    if (s.persona && PERSONA_PHRASES[s.persona]) values.persona = PERSONA_PHRASES[s.persona][locale];
    return values;
  }

  private template(tier: BannerTier, locale: Locale, values: CopyValues, rng: () => number, angle?: BigTripAngle): CopyTemplate | null {
    const eligible = this.copy[tier][locale].filter((t) => (angle ? t.angle === angle : true) && isEligible(t, values));
    if (eligible.length === 0) return null;
    return eligible[Math.floor(rng() * eligible.length)];
  }

  /** The filled template, with an AI-refreshed headline/subline pair in front of it when one is stored. */
  private render(template: CopyTemplate, values: CopyValues, ai: HomeCopy | undefined, rng: () => number): { headline: string; subline: string; plannerPrompt: string } {
    const prompt = fill(template.plannerPrompt, values);
    if (ai && ai.variants.length > 0) {
      const variant = ai.variants[Math.floor(rng() * ai.variants.length)];
      return { headline: variant.headline, subline: variant.subline, plannerPrompt: prompt };
    }
    return { headline: fill(template.headline, values), subline: fill(template.subline, values), plannerPrompt: prompt };
  }

  private async build(tier: BannerTier, destination: Destination, locale: Locale, facts: BannerFacts, s: Signals, rng: () => number): Promise<BannerDto | null> {
    const values = this.values(destination, locale, facts, s);
    const template = this.template(tier, locale, values, rng);
    if (!template) return null;
    const ai = await this.aiCopy(destination.id, tier, locale, this.now());
    const copy = this.render(template, values, ai.get(''), rng);
    this.remember(destination.id, tier, locale, '');
    const photo = await this.photo(destination);
    return { tier, destinationId: destination.id, name: destination.names[locale], country: destination.country, eyebrow: EYEBROWS[tier][locale], ...copy, cta: CTA[locale], photo, facts };
  }

  /** Stored AI copy for the destination, tier and locale, by angle ('' for the other tiers). */
  private async aiCopy(destinationId: string, tier: BannerTier, locale: Locale, now: Date): Promise<Map<string, HomeCopy>> {
    const rows = await this.homeCopy.find({ where: { destinationId, tier, locale, expiresAt: MoreThan(now) } });
    return new Map(rows.map((r) => [r.angle, r]));
  }

  private remember(destinationId: string, tier: BannerTier, locale: Locale, angle: string): void {
    this.served.set(`${destinationId}|${tier}|${locale}|${angle}`, { destinationId, tier, locale, angle });
  }

  private async photo(destination: Destination): Promise<BannerDto['photo']> {
    const photos = await this.media.cityPhotos(`${destination.names.en}, ${countryName(destination.country, 'en').replace(/^the /, '')}`, 1, 'large');
    return photos[0] ? { url: photos[0].url, attributions: photos[0].attributions } : null;
  }
}
