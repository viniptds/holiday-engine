import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { Moment } from '../moments/moment.entity.js';
import { MemoryObjectStorage } from '../moments/testing/moments-testing.js';
import { bootMoments, DAY_MS, EDITOR, isoDay, OTHER, OWNER, VIEWER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import type { CreatedMomentDto } from '../moments/moments.types.js';
import { User } from '../users/user.entity.js';
import { AchievementsService } from './achievements.service.js';
import { UserAchievement } from './user-achievement.entity.js';
import type { AchievementDto, JourneyNode } from './achievements.types.js';
import { RateWindow } from '../app-common/rate-window.js';
import { EVENT_RATE_LIMIT } from './achievements.types.js';

type Journey = { nodes: JourneyNode[]; achievements: AchievementDto[] };

describe('Achievements and the Journey (feature)', () => {
  const storage = new MemoryObjectStorage();
  let h: Harness;

  beforeAll(async () => {
    h = await bootMoments({ storage });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.db.clear();
    h.seedUsers();
    storage.reset();
    Object.assign(h.moduleRef.get(AchievementsService), {
      events: new RateWindow(EVENT_RATE_LIMIT.max, EVENT_RATE_LIMIT.windowMs, 'Too many achievement events. Please wait a little.'),
    });
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  /** Unlocked keys for the user, as `key` or `key@trip`. */
  const keys = (userId: string, tripId?: string) =>
    h.db
      .all(UserAchievement, { userId })
      .filter((a) => tripId === undefined || a.tripId === tripId)
      .map((a) => a.key)
      .sort();

  async function createTrip(user: string, fields: Record<string, unknown> = {}): Promise<AppTripDto> {
    const res = await h.json<AppTripDto>('POST', '/trips', user, { destination: 'Lisbon', startDate: isoDay(20), endDate: isoDay(21), ...fields });
    expect(res.status).toBe(201);
    return res.body;
  }

  async function join(tripId: string, user: string, role = 'editor') {
    const invite = await h.json<{ url: string }>('POST', `/trips/${tripId}/invites`, OWNER, { role });
    const token = invite.body.url.split('/').pop();
    expect((await h.json('POST', `/invites/${token}/accept`, user)).status).toBe(200);
  }

  async function addPlace(tripId: string, day: number | null, user = OWNER) {
    const res = await h.json('POST', `/trips/${tripId}/places`, user, { googlePlaceId: `mock-${randomUUID().slice(0, 8)}`, day });
    expect(res.status).toBe(201);
  }

  async function takeMoment(user: string, tripId: string | null, takenAt: string) {
    const created = await h.json<CreatedMomentDto>('POST', '/moments', user, { tripId, contentType: 'image/jpeg', byteSize: 10, width: 1, height: 1, takenAt });
    expect(created.status).toBe(201);
    storage.put(h.db.all(Moment, { id: created.body.moment.id })[0].objectKey, 10);
    expect((await h.json('POST', `/moments/${created.body.moment.id}/complete`, user)).status).toBe(200);
    return created.body.moment.id;
  }

  function seedMoments(userId: string, count: number, tripId: string | null = null) {
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      h.db.seed(Moment, {
        id, userId, tripId, status: 'ready', objectKey: `moments/${userId}/${id}.jpg`, contentType: 'image/jpeg',
        byteSize: 1, width: 1, height: 1, takenAt: new Date(), takenOn: isoDay(-400), completedAt: new Date(),
      });
    }
  }

  describe('planning milestones (per trip, every member)', () => {
    it('unlocks trip_created on create, first_place on the first place and all_days_planned once every day has one', async () => {
      const trip = await createTrip(OWNER);
      expect(keys(OWNER, trip.id)).toEqual(['trip_created']);

      await addPlace(trip.id, 1);
      expect(keys(OWNER, trip.id)).toEqual(['first_place', 'trip_created']);
      await addPlace(trip.id, null);
      expect(keys(OWNER, trip.id)).not.toContain('all_days_planned');
      await addPlace(trip.id, 2);
      expect(keys(OWNER, trip.id)).toEqual(['all_days_planned', 'first_place', 'trip_created']);
    });

    it('unlocks first_member_joined when someone accepts an invite, for every member', async () => {
      const trip = await createTrip(OWNER);

      await join(trip.id, EDITOR);

      expect(keys(OWNER, trip.id)).toEqual(['first_member_joined', 'trip_created']);
      expect(keys(EDITOR, trip.id)).toEqual(['first_member_joined', 'trip_created']);
    });

    it('re-checks after an itinerary PUT', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(10), endDate: isoDay(10) });
      const place = h.db.seed(TripPlace, {
        tripId: trip.id, googlePlaceId: 'mock-1', name: 'A', address: 'a', lat: 0, lng: 0, rating: null, mapsUrl: null,
        types: [], category: 'other', day: null, position: 0, source: 'user', createdBy: OWNER,
      } as Partial<TripPlace>);

      const put = await h.json('PUT', `/trips/${trip.id}/itinerary`, OWNER, { itineraryVersion: 0, days: [{ day: 1, placeIds: [place.id] }] });

      expect(put.status).toBe(200);
      expect(keys(OWNER, trip.id)).toEqual(['all_days_planned', 'first_place', 'trip_created']);
    });

    it('is idempotent: repeated and concurrent checks store each achievement once', async () => {
      const trip = await createTrip(OWNER);
      const service = h.moduleRef.get(AchievementsService);

      await Promise.all([service.evaluateTrip(trip.id), service.evaluateTrip(trip.id), service.evaluateTrip(trip.id)]);
      await h.json('PATCH', `/trips/${trip.id}`, OWNER, { notes: 'x' });

      expect(h.db.all(UserAchievement, { userId: OWNER, key: 'trip_created' })).toHaveLength(1);
    });
  });

  describe('trip dates and days (lazy, in each user\'s time zone)', () => {
    it('unlocks trip_started and trip_finished on read, with no write needed', async () => {
      const past = h.seedTrip([[OWNER, 'owner'], [VIEWER, 'viewer']], { startDate: isoDay(-10), endDate: isoDay(-8) });
      const ongoing = h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(-1), endDate: isoDay(1) });
      const future = h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(5), endDate: isoDay(6) });

      const res = await h.json<{ achievements: AchievementDto[] }>('GET', '/me/achievements', OWNER);

      expect(res.status).toBe(200);
      expect(keys(OWNER, past.id)).toEqual(['first_member_joined', 'trip_created', 'trip_finished', 'trip_started']);
      expect(keys(OWNER, ongoing.id)).toEqual(['trip_created', 'trip_started']);
      expect(keys(OWNER, future.id)).toEqual([]);
      // Only the reader's own are evaluated.
      expect(keys(VIEWER)).toEqual([]);
      expect(res.body.achievements.every((a) => a.seen === false && typeof a.unlockedAt === 'string')).toBe(true);
    });

    it("uses the user's stored time zone for the date", async () => {
      const tomorrowUtc = isoDay(1);
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: tomorrowUtc, endDate: tomorrowUtc });
      await h.moduleRef.get(AchievementsService).evaluateTrip(trip.id);
      expect(keys(OWNER, trip.id)).not.toContain('trip_started');

      // Kiritimati is UTC+14: there it's already "tomorrow (UTC)" for most of the UTC day.
      await h.json('GET', '/me', OWNER, undefined, { 'x-timezone': 'Pacific/Kiritimati' });
      expect(h.db.all(User, { id: OWNER })[0].timezone).toBe('Pacific/Kiritimati');
      await h.moduleRef.get(AchievementsService).evaluateTrip(trip.id);
      const todayThere = new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Kiritimati' }).format(new Date());
      expect(keys(OWNER, trip.id).includes('trip_started')).toBe(todayThere >= tomorrowUtc);
    });

    it('unlocks day_completed:<n> when a moment is taken on day n, for every member', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']], { startDate: isoDay(-1), endDate: isoDay(1) });

      await takeMoment(EDITOR, trip.id, new Date().toISOString());

      expect(keys(EDITOR, trip.id)).toContain('day_completed:2');
      expect(keys(OWNER, trip.id)).toContain('day_completed:2');
      expect(keys(OWNER, trip.id)).not.toContain('day_completed:1');
    });
  });

  describe('photos (per user)', () => {
    it('unlocks first_moment, then moments_10 / 25 / 50 across trips and unassigned', async () => {
      await takeMoment(OWNER, null, new Date().toISOString());
      expect(keys(OWNER)).toEqual(['first_moment']);

      seedMoments(OWNER, 8);
      seedMoments(OWNER, 15, h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(50), endDate: isoDay(51) }).id);
      await takeMoment(OWNER, null, new Date().toISOString());
      expect(keys(OWNER).filter((k) => k.startsWith('moments_') || k === 'first_moment')).toEqual(['first_moment', 'moments_25', 'moments_10'].sort());

      seedMoments(OWNER, 25);
      await h.json('GET', '/me/achievements', OWNER);
      expect(keys(OWNER)).toContain('moments_50');
    });

    it('unlocks first_collage_shared from the collage event, once, for members only', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']]);

      expect((await h.json('POST', '/achievements/events', OTHER, { type: 'collage_shared', tripId: trip.id })).status).toBe(404);
      expect((await h.json('POST', '/achievements/events', OWNER, { type: 'photo_liked', tripId: trip.id })).status).toBe(400);
      const res = await h.json<{ achievements: AchievementDto[] }>('POST', '/achievements/events', OWNER, { type: 'collage_shared', tripId: trip.id });
      await h.json('POST', '/achievements/events', OWNER, { type: 'collage_shared', tripId: trip.id });

      expect(res.status).toBe(200);
      expect(res.body.achievements).toEqual([{ key: 'first_collage_shared', tripId: null, unlockedAt: expect.any(String), seen: false }]);
      expect(h.db.all(UserAchievement, { key: 'first_collage_shared' })).toHaveLength(1);
    });

    it('rate-limits collage events (30 an hour)', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']]);
      for (let i = 0; i < 30; i++) expect((await h.call('POST', '/achievements/events', OWNER, { type: 'collage_shared', tripId: trip.id })).status).toBe(200);

      expect((await h.call('POST', '/achievements/events', OWNER, { type: 'collage_shared', tripId: trip.id })).status).toBe(429);
    });
  });

  describe('explorer (countries and cities of trips that have started)', () => {
    it('resolves destinations on save and counts distinct countries and cities', async () => {
      const created = await createTrip(OWNER, { destination: 'Madrid', startDate: isoDay(-3), endDate: isoDay(-2) });

      expect(h.db.all(Trip, { id: created.id })[0]).toMatchObject({ countryCode: 'ES', cityPlaceId: 'mock-city-madrid' });
      expect(keys(OWNER)).toContain('countries_1');
    });

    it('backfills older trips lazily, skips trips that have not started, and unlocks the thresholds', async () => {
      const started = ['Lisbon', 'Porto', 'Madrid', 'Barcelona', 'Paris'].map((destination, i) =>
        h.seedTrip([[OWNER, 'owner']], { destination, startDate: isoDay(-100 + i * 10), endDate: isoDay(-99 + i * 10) }),
      );
      h.seedTrip([[OWNER, 'owner']], { destination: 'Rome', startDate: isoDay(30), endDate: isoDay(31) });

      await h.json('GET', '/me/achievements', OWNER);

      expect(started.map((t) => h.db.all(Trip, { id: t.id })[0].countryCode)).toEqual(['PT', 'PT', 'ES', 'ES', 'FR']);
      const explorer = keys(OWNER).filter((k) => k.startsWith('countries_') || k.startsWith('cities_'));
      expect(explorer).toEqual(['cities_5', 'countries_1', 'countries_3']);
    });

    it('reaches countries_5 / 10 and cities_10, resolving at most 5 old trips per request', async () => {
      const cities = ['Lisbon', 'Madrid', 'Paris', 'Rome', 'London', 'Berlin', 'Amsterdam', 'Tokyo', 'Lima', 'Sydney'];
      cities.forEach((destination, i) => h.seedTrip([[OWNER, 'owner']], { destination, startDate: isoDay(-200 + i * 10), endDate: isoDay(-199 + i * 10) }));

      await h.json('GET', '/me/achievements', OWNER);
      expect(h.db.all(Trip).filter((t) => t.cityPlaceId).length).toBe(5);
      expect(keys(OWNER).filter((k) => k.startsWith('countries_'))).toEqual(['countries_1', 'countries_3', 'countries_5']);

      await h.json('GET', '/me/achievements', OWNER);
      expect(keys(OWNER).filter((k) => k.startsWith('countries_') || k.startsWith('cities_'))).toEqual([
        'cities_10',
        'cities_5',
        'countries_1',
        'countries_10',
        'countries_3',
        'countries_5',
      ]);
    });

    it('resolves a changed destination again', async () => {
      const trip = await createTrip(OWNER, { destination: 'Lisbon' });
      expect(h.db.all(Trip, { id: trip.id })[0].countryCode).toBe('PT');

      await h.json('PATCH', `/trips/${trip.id}`, OWNER, { destination: 'Paris' });

      expect(h.db.all(Trip, { id: trip.id })[0]).toMatchObject({ countryCode: 'FR', cityPlaceId: 'mock-city-paris' });
    });
  });

  describe('seen', () => {
    it("marks the caller's own achievements seen", async () => {
      const trip = await createTrip(OWNER);
      await join(trip.id, EDITOR);

      expect((await h.call('POST', '/achievements/seen', OWNER, { keys: [{ key: 'trip_created', tripId: trip.id }, { key: 'nope', tripId: null }] })).status).toBe(204);

      const mine = (await h.json<{ achievements: AchievementDto[] }>('GET', '/me/achievements', OWNER)).body.achievements;
      expect(mine.find((a) => a.key === 'trip_created')?.seen).toBe(true);
      expect(mine.find((a) => a.key === 'first_member_joined')?.seen).toBe(false);
      expect(h.db.all(UserAchievement, { userId: EDITOR, key: 'trip_created' })[0].seenAt).toBeNull();
      expect((await h.call('POST', '/achievements/seen', OWNER, { keys: [{ key: 'x', tripId: 'nope' }] })).status).toBe(400);
    });
  });

  describe('GET /trips/:id/journey', () => {
    it('lists the planning milestones, Day 1…N and Trip finished, with their states and up to 3 thumbnails a day', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [VIEWER, 'viewer']], { startDate: isoDay(-1), endDate: isoDay(1) });
      for (let i = 0; i < 4; i++) await takeMoment(VIEWER, trip.id, new Date(Date.now() - DAY_MS - i * 60_000).toISOString());

      const res = await h.json<Journey>('GET', `/trips/${trip.id}/journey`, OWNER);

      expect(res.status).toBe(200);
      expect(res.body.nodes.map(({ momentThumbs, ...node }) => ({ ...node, thumbs: momentThumbs?.length }))).toEqual([
        { kind: 'milestone', key: 'trip_created', title: 'Trip created', status: 'done', thumbs: undefined },
        { kind: 'milestone', key: 'first_place', title: 'First place added', status: 'current', thumbs: undefined },
        { kind: 'milestone', key: 'all_days_planned', title: 'Every day planned', status: 'current', thumbs: undefined },
        { kind: 'milestone', key: 'first_member_joined', title: 'First person joined', status: 'done', thumbs: undefined },
        { kind: 'day', key: 'day_completed:1', title: 'Day 1', day: 1, date: isoDay(-1), status: 'done', thumbs: 3 },
        { kind: 'day', key: 'day_completed:2', title: 'Day 2', day: 2, date: isoDay(0), status: 'current', thumbs: 0 },
        { kind: 'day', key: 'day_completed:3', title: 'Day 3', day: 3, date: isoDay(1), status: 'locked', thumbs: 0 },
        { kind: 'milestone', key: 'trip_finished', title: 'Trip finished', status: 'current', thumbs: undefined },
      ]);
      expect(res.body.nodes[4].momentThumbs!.every((url) => url.startsWith('https://bucket.test/moments/'))).toBe(true);
      expect(res.body.achievements.map((a) => a.key).sort()).toEqual(['day_completed:1', 'first_member_joined', 'trip_created', 'trip_started']);
      expect(res.body.achievements.every((a) => a.tripId === trip.id)).toBe(true);
    });

    it.each([
      ['pt-BR', ['Viagem criada', 'Primeiro lugar adicionado', 'Todos os dias planejados', 'Primeira pessoa entrou', 'Dia 1', 'Viagem concluída']],
      ['es-MX', ['Viaje creado', 'Primer lugar agregado', 'Todos los días planeados', 'Se unió la primera persona', 'Día 1', 'Viaje terminado']],
      ['fr', ['Trip created', 'First place added', 'Every day planned', 'First person joined', 'Day 1', 'Trip finished']],
    ])('localizes the titles for %s', async (language, titles) => {
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(5), endDate: isoDay(5) });

      const res = await h.json<Journey>('GET', `/trips/${trip.id}/journey`, OWNER, undefined, { 'accept-language': language });

      expect(res.body.nodes.map((n) => n.title)).toEqual(titles);
      expect(res.body.nodes.at(-1)?.status).toBe('locked');
    });

    it('marks a finished trip done and a past day done even without photos', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']], { startDate: isoDay(-5), endDate: isoDay(-4) });

      const res = await h.json<Journey>('GET', `/trips/${trip.id}/journey`, OWNER);

      expect(res.body.nodes.slice(-3).map((n) => n.status)).toEqual(['done', 'done', 'done']);
    });

    it('is for members only', async () => {
      const trip = h.seedTrip([[OWNER, 'owner']]);
      expect((await h.json('GET', `/trips/${trip.id}/journey`, OTHER)).status).toBe(404);
      expect((await h.json('GET', `/trips/not-a-trip/journey`, OWNER)).status).toBe(404);
    });
  });
});
