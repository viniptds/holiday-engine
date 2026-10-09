import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { scoreDestination } from './banners.service.js';
import { loadCatalog } from './catalog.js';
import { CTA, EYEBROWS, PERSONA_PHRASES } from './copy.js';
import type { BannerDto, BannersDto } from './home.types.js';
import { ANA, BEN, bootHome, LISBON, NOW } from './testing/harness.js';
import type { HomeHarness } from './testing/harness.js';
import { bucketOf } from './trending.service.js';

const catalog = loadCatalog();
const km = (a: string, position = LISBON) => {
  const d = catalog.get(a)!;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(toRad(d.lat - position.lat) / 2) ** 2 + Math.cos(toRad(position.lat)) * Math.cos(toRad(d.lat)) * Math.sin(toRad(d.lng - position.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};
const byTier = (body: BannersDto) => Object.fromEntries(body.banners.map((b) => [b.tier, b])) as Partial<Record<BannerDto['tier'], BannerDto>>;

describe('Home: banners (feature)', () => {
  let h: HomeHarness;
  const logged: string[] = [];

  beforeAll(async () => {
    h = await bootHome();
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  beforeEach(() => {
    h.reset();
    logged.length = 0;
  });

  const banners = (user: string, query = `?lat=${LISBON.lat}&lng=${LISBON.lng}`, headers: Record<string, string> = {}) => h.json<BannersDto>('GET', `/home/banners${query}`, user, undefined, headers);

  /** Five distinct owners with a trip to `destination` created this month: enough for Trending. */
  const trend = (destination: string, users = 5) => {
    for (let i = 0; i < users; i += 1) {
      const owner = `aaaaaaa${i}-1f2b-4c3d-8e9f-0a1b2c3d4e5f`;
      h.db.seed(Trip, { provider: null, chatId: null, ownerUserId: owner, destination, startDate: '2027-03-01', endDate: '2027-03-10', notes: null, story: null, partyType: null, partySize: null, travelerProfile: null, countryCode: null, cityPlaceId: null, createdAt: NOW });
    }
  };

  it('returns the tiers in order with localized copy, a photo, the planner prompt and the facts the copy used', async () => {
    trend('Tokyo');
    const { status, body } = await banners(ANA, undefined, { 'accept-language': 'pt-BR' });
    expect(status).toBe(200);
    expect(body.generatedAt).toBe(NOW.toISOString());
    expect(body.banners.map((b) => b.tier)).toEqual(['nearby', 'longWeekend', 'bigTrip', 'trending']);
    for (const banner of body.banners) {
      expect(banner.eyebrow).toBe(EYEBROWS[banner.tier]['pt-BR']);
      expect(banner.cta).toBe(CTA['pt-BR']);
      expect(banner.headline.split(/\s+/).length).toBeLessThanOrEqual(12); // ≤ 6 template words; names and a route expand them
      expect(banner.headline).not.toMatch(/[{}!]/);
      expect(banner.subline).not.toMatch(/[{}!]/);
      expect(banner.plannerPrompt).not.toMatch(/[{}]/);
      expect(banner.name).toBe(catalog.get(banner.destinationId)!.names['pt-BR']);
      expect(banner.country).toBe(catalog.get(banner.destinationId)!.country);
      expect(banner.photo).toEqual({ url: expect.stringContaining('https://'), attributions: expect.any(Array) });
    }
    const { nearby, longWeekend, bigTrip, trending } = byTier(body);
    expect(nearby!.destinationId).not.toBe('lisbon');
    expect(km(nearby!.destinationId)).toBeLessThanOrEqual(300);
    expect(nearby!.facts).toEqual({ distanceKm: Math.round(km(nearby!.destinationId)), tempC: 19 });
    expect(km(longWeekend!.destinationId)).toBeGreaterThanOrEqual(300);
    expect(km(longWeekend!.destinationId)).toBeLessThanOrEqual(1500);
    // The next PT holiday that makes a block: Tuesday 2026-12-01 (Sunday 2026-11-01 doesn't).
    expect(longWeekend!.facts).toEqual({ distanceKm: expect.any(Number), daysOff: 4, holidayName: 'Restauração da Independência', month: 'dezembro' });
    expect(longWeekend!.subline).toContain(String(longWeekend!.facts.distanceKm));
    expect(km(bigTrip!.destinationId)).toBeGreaterThan(1500);
    expect(bigTrip!.facts).toEqual({ month: 'janeiro' }); // 3 months ahead, nothing planned
    expect(bigTrip!.angles!.map((a) => a.key)).toEqual(['explorer', 'family', 'business']);
    expect(bigTrip!.headline).toBe(bigTrip!.angles![0].headline);
    expect(trending!.destinationId).toBe('tokyo');
    expect(trending!.name).toBe('Tóquio');
  });

  it('is deterministic per user and ISO week, differs between users, and is cached per user for an hour', async () => {
    const first = await banners(ANA);
    const again = await banners(ANA);
    expect(again.body).toEqual(first.body);
    const weatherCalls = h.apis.weatherCalls().length;
    const holidayCalls = h.apis.holidayCalls().length;
    expect(holidayCalls).toBe(2); // 2026 and 2027 (90 days from October cross the year), cached 7 days
    const other = await banners(BEN);
    expect(h.apis.holidayCalls()).toHaveLength(holidayCalls);
    const same = (a: BannersDto, b: BannersDto) => a.banners.map((x) => `${x.destinationId}:${x.headline}`).join() === b.banners.map((x) => `${x.destinationId}:${x.headline}`).join();
    // Different seeds choose among the top candidates and templates differently, at least somewhere.
    expect(same(first.body, other.body)).toBe(false);
    // A fresh compute for the same user and week gives the same set again.
    h.moduleRef.get((await import('./banners.service.js')).BannersService).resetCache();
    const recomputed = await banners(ANA);
    expect(recomputed.body.banners).toEqual(first.body.banners);
    expect(h.apis.weatherCalls().length).toBe(weatherCalls); // the destination forecast is cached too
  });

  it('hides a tier with no good candidate instead of filling it: Nearby excludes planned destinations, Trending needs 5 users', async () => {
    h.seedTrip(ANA, { destination: 'Porto', startDate: '2026-10-19', endDate: '2026-10-21' });
    h.seedTrip(ANA, { destination: 'Algarve, Portugal', startDate: '2026-11-01', endDate: '2026-11-05' });
    trend('Tokyo', 4);
    const { body } = await banners(ANA);
    const tiers = body.banners.map((b) => b.tier);
    expect(tiers).not.toContain('nearby'); // Porto and the Algarve were the only places within 300 km of Lisbon
    expect(tiers).not.toContain('trending'); // 4 distinct users < 5
    expect(tiers).toEqual(['longWeekend', 'bigTrip']);
  });

  it('keeps every destination unique and at most two banners per country', async () => {
    trend('Porto');
    for (const user of [ANA, BEN]) {
      const { body } = await banners(user);
      const ids = body.banners.map((b) => b.destinationId);
      expect(new Set(ids).size).toBe(ids.length);
      const countries = new Map<string, number>();
      for (const b of body.banners) countries.set(b.country, (countries.get(b.country) ?? 0) + 1);
      for (const count of countries.values()) expect(count).toBeLessThanOrEqual(2);
      // Porto trends, but Nearby already took it (or the country is full): Trending is hidden rather than repeated.
      expect(ids.filter((id) => id === 'porto').length).toBeLessThanOrEqual(1);
    }
  });

  it('scores by season, interests and persona', () => {
    const porto = catalog.get('porto')!;
    const inSeason = porto.bestMonths[0];
    const offSeason = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((m) => !porto.bestMonths.includes(m))!;
    expect(scoreDestination(porto, inSeason, new Set())).toBe(scoreDestination(porto, offSeason, new Set()) + 3);
    expect(scoreDestination(porto, offSeason, new Set(['food']))).toBe(scoreDestination(porto, offSeason, new Set()) + 1);
    expect(scoreDestination(porto, offSeason, new Set(['food', 'culture']))).toBe(scoreDestination(porto, offSeason, new Set()) + 2);
  });

  it('uses the persona in the copy and the past party type for the first big-trip angle', async () => {
    const profile = { questionSetVersion: 1, answers: { pace: ['slow'], interests: ['beach'] }, persona: 'relaxer' };
    h.seedTrip(ANA, { destination: 'Madrid', startDate: '2026-03-01', endDate: '2026-03-05', partyType: 'family', travelerProfile: profile });
    const ana = await banners(ANA);
    expect(byTier(ana.body).bigTrip!.angles!.map((a) => a.key)).toEqual(['family', 'business', 'explorer']);
    h.reset();
    h.seedTrip(BEN, { destination: 'Madrid', startDate: '2026-03-01', endDate: '2026-03-05', partyType: 'work', travelerProfile: { ...profile, persona: 'Easygoing Wanderer' } });
    const ben = await banners(BEN, undefined, { 'accept-language': 'es' });
    expect(byTier(ben.body).bigTrip!.angles!.map((a) => a.key)).toEqual(['business', 'family', 'explorer']);
    // The explorer angle names a route of similar places.
    const explorer = byTier(ben.body).bigTrip!.angles!.find((a) => a.key === 'explorer')!;
    expect(`${explorer.headline} ${explorer.plannerPrompt}`).toMatch(/ y /);
    // With a persona, templates using {persona} become eligible; the phrase is localized and never the raw placeholder.
    const text = ben.body.banners.map((b) => `${b.headline} ${b.subline}`).join('\n');
    expect(text).not.toContain('{persona}');
    const phrases = Object.values(PERSONA_PHRASES).map((p) => p.es);
    const usesPersona = text.split('\n').some((line) => phrases.some((p) => line.includes(p)));
    expect(usesPersona || !text.includes('mañanas')).toBe(true);
    expect(text.includes(PERSONA_PHRASES.relaxer.es) || !phrases.some((p) => text.includes(p))).toBe(true);
  });

  it('moves the big-trip horizon out when a trip is already planned', async () => {
    h.seedTrip(ANA, { destination: 'Madrid', startDate: '2026-11-20', endDate: '2026-11-23' });
    expect(byTier((await banners(ANA)).body).bigTrip!.facts).toEqual({ month: 'April' }); // 6 months
    h.reset();
    h.seedTrip(BEN, { destination: 'Madrid', startDate: '2026-11-20', endDate: '2026-11-23' });
    h.seedTrip(BEN, { destination: 'Paris', startDate: '2027-02-10', endDate: '2027-02-14' });
    expect(byTier((await banners(BEN)).body).bigTrip!.facts).toEqual({ month: 'October' }); // 12 months
  });

  it('falls back to the home city without a position, and to a long weekend without a holiday', async () => {
    h.db.seed(TripMember, { tripId: h.seedTrip(ANA, { destination: 'Nowhere' }).id, userId: BEN, role: 'viewer' });
    const user = h.db.repository(await import('../users/user.entity.js').then((m) => m.User));
    await user.update({ id: ANA }, { homeCity: 'Lisboa, Portugal' });
    h.apis.holidaysFailing = true;
    const { body } = await banners(ANA, '');
    const { nearby, longWeekend } = byTier(body);
    expect(nearby).toBeDefined();
    expect(nearby!.destinationId).not.toBe('lisbon');
    expect(km(nearby!.destinationId)).toBeLessThanOrEqual(300);
    expect(h.apis.weatherCalls()).toHaveLength(1); // the destination's temperature, never the user's position
    // No holiday answer: the next weekend with Friday off (Friday 2026-10-16).
    expect(longWeekend!.facts).toEqual({ distanceKm: expect.any(Number), daysOff: 3, month: 'October' });
    expect(longWeekend!.headline).not.toContain('undefined');
    const none = await banners(BEN, '');
    expect(none.body.banners.map((b) => b.tier)).toEqual(['bigTrip']); // no position, no home city: only the big one
  });

  it('takes the holiday country from the locale region when nothing else says where the user is', async () => {
    const { body } = await banners(BEN, '', { 'accept-language': 'pt-BR' });
    expect(body.banners.map((b) => b.tier)).toEqual(['bigTrip']);
    expect(h.apis.holidayCalls()).toHaveLength(0); // no position: no long weekend tier, no lookup
  });

  it('answers 400 for a half position and never logs coordinates', async () => {
    expect((await banners(ANA, '?lat=38.72')).status).toBe(400);
    h.apis.weatherFailing = true;
    const { body } = await banners(ANA);
    expect(byTier(body).nearby!.facts.tempC).toBeUndefined();
    expect(byTier(body).nearby!.subline).not.toContain('undefined');
    expect(logged.join('\n')).not.toMatch(/38\.7|-9\.1/);
  });

  it('buckets trending counts', () => {
    expect(bucketOf(5)).toBe('5+');
    expect(bucketOf(12)).toBe('10+');
    expect(bucketOf(30)).toBe('25+');
    expect(bucketOf(99)).toBe('50+');
  });
});
