import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { TripRole } from '../app-trips/app-trips.types.js';
import { accessTokens, seedUser } from '../testing/app-testing.js';
import { barrier } from '../testing/in-memory-db.js';
import { aiDb, aiTestingModule } from './testing/ai-db.js';
import { TripPlace } from './entities/trip-place.entity.js';
import { MockPlacesProvider, MOCK_CENTER } from './places/mock-places.provider.js';
import { PLACES_PROVIDER } from './places/places-provider.js';
import type { PlaceListSearch, PlaceMatch, PlaceSearch, PlacesDirectory } from './places/places-provider.js';
import { ItineraryService } from './itinerary.service.js';
import type { AiConversationDto, AiTurnDto, ItineraryDto, PlaceCategory, PlaceSearchResultDto, TripPlaceDto } from './ai.types.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { AiConversation } from './entities/ai-conversation.entity.js';

// docs/app-itinerary-spec.md, "Tests and acceptance › Engine". Google is a fake: no real calls.

const OWNER = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const VIEWER = '33333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OUTSIDER = '44444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS = [OWNER, EDITOR, VIEWER, OUTSIDER];
const ROLE_USERS: Record<string, string> = { owner: OWNER, editor: EDITOR, viewer: VIEWER, outsider: OUTSIDER };

const near = (dLat = 0.01, dLng = 0.01) => ({ lat: MOCK_CENTER.lat + dLat, lng: MOCK_CENTER.lng + dLng });

/** A Google place as Place Details / Text Search return it. */
const google = (id: string, overrides: Partial<PlaceMatch> = {}): PlaceMatch => ({
  googlePlaceId: id,
  name: `Google name ${id}`,
  address: `Rua ${id}, Lisboa`,
  location: near(),
  rating: 4.5,
  types: ['point_of_interest'],
  mapsUrl: `https://maps.google.com/?cid=${id}`,
  ...overrides,
});

/** Controllable places directory: the destination resolves to MOCK_CENTER; details and search come from `catalog`. */
class FakeDirectory implements PlacesDirectory {
  readonly name = 'mock' as const;
  private readonly mock = new MockPlacesProvider();
  catalog = new Map<string, PlaceMatch>();
  failDetails = false;
  failSearch = false;
  searchTextCalls: PlaceSearch[] = [];
  searchManyCalls: PlaceListSearch[] = [];
  detailsCalls: [string, string][] = [];

  reset() {
    this.catalog.clear();
    this.failDetails = this.failSearch = false;
    this.searchTextCalls = [];
    this.searchManyCalls = [];
    this.detailsCalls = [];
  }

  async searchText(search: PlaceSearch) {
    this.searchTextCalls.push(search);
    // The AI verifier's lookups and the destination centre.
    return this.mock.searchText(search);
  }

  async searchMany(search: PlaceListSearch) {
    this.searchManyCalls.push(search);
    if (this.failSearch) throw new Error('Places search failed: HTTP 500');
    return [...this.catalog.values()].slice(0, search.limit);
  }

  async details(id: string, languageCode: string) {
    this.detailsCalls.push([id, languageCode]);
    if (this.failDetails) throw new Error('Place details failed: HTTP 503');
    return this.catalog.get(id) ?? null;
  }
}

describe('Trip places and itinerary (feature)', () => {
  const db = aiDb();
  const directory = new FakeDirectory();
  let app: INestApplication;
  let baseUrl: string;
  let tokens: Record<string, string>;
  let moduleRef: Awaited<ReturnType<ReturnType<typeof aiTestingModule>['compile']>>;

  beforeAll(async () => {
    moduleRef = await aiTestingModule(db).overrideProvider(PLACES_PROVIDER).useValue(directory).compile();
    tokens = await accessTokens(moduleRef, USERS);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.clear();
    for (const id of USERS) seedUser(db, id);
    db.afterRead = undefined;
    db.beforeWrite = undefined;
    directory.reset();
    // A fresh limiter and centre cache per test.
    Object.assign(moduleRef.get(ItineraryService) as unknown as { searches: Map<string, number[]>; centers: Map<string, unknown> }, {
      searches: new Map(),
      centers: new Map(),
    });
    jest.restoreAllMocks();
    for (const level of ['log', 'warn', 'error', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  const call = (method: string, path: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T>(response: Response) => (await response.json()) as T;

  /** A 3-day trip (2026-11-10 to 2026-11-12) in Lisbon with an owner, an editor and a viewer. */
  function seedTrip(fields: Partial<Trip> = {}): Trip {
    const trip = db.seed(Trip, {
      provider: null,
      chatId: null,
      ownerUserId: OWNER,
      destination: 'Lisbon',
      startDate: '2026-11-10',
      endDate: '2026-11-12',
      notes: null,
      story: null,
      partyType: null,
      partySize: null,
      travelerProfile: null,
      ...fields,
    });
    for (const [userId, role] of [
      [OWNER, 'owner'],
      [EDITOR, 'editor'],
      [VIEWER, 'viewer'],
    ] as [string, TripRole][]) {
      db.seed(TripMember, { tripId: trip.id, userId, role });
    }
    return trip;
  }

  /** A place already on the trip. */
  function seedPlace(tripId: string, day: number | null, position: number, fields: Partial<TripPlace> = {}): TripPlace {
    const id = fields.googlePlaceId ?? `g-${randomUUID().slice(0, 8)}`;
    return db.seed(TripPlace, {
      tripId,
      googlePlaceId: id,
      name: `Seeded ${id}`,
      category: 'sight',
      day,
      position,
      startTime: null,
      notes: null,
      address: 'Somewhere',
      lat: MOCK_CENTER.lat,
      lng: MOCK_CENTER.lng,
      rating: null,
      mapsUrl: null,
      types: [],
      source: 'user',
      createdBy: OWNER,
      ...fields,
    });
  }

  const version = (tripId: string) => db.all(Trip, { id: tripId })[0].itineraryVersion;
  const order = (tripId: string) =>
    db
      .all(TripPlace, { tripId })
      .sort((a, b) => (a.day ?? 99) - (b.day ?? 99) || a.position - b.position)
      .map((p) => [p.googlePlaceId, p.day, p.position]);
  const add = (tripId: string, body: Record<string, unknown>, user = OWNER, headers: Record<string, string> = {}) =>
    call('POST', `/trips/${tripId}/places`, user, body, headers);
  const search = (tripId: string, query: string, user = OWNER, headers: Record<string, string> = {}) =>
    call('GET', `/trips/${tripId}/places/search?${query}`, user, undefined, headers);
  const put = (tripId: string, body: unknown, user = OWNER) => call('PUT', `/trips/${tripId}/itinerary`, user, body);

  describe('role matrix', () => {
    it.each([
      ['owner', 200, 201, 200, 204, 200],
      ['editor', 200, 201, 200, 204, 200],
      ['viewer', 403, 403, 403, 403, 403],
      ['outsider', 404, 404, 404, 404, 404],
    ])('%s: search %i, add %i, patch %i, delete %i, PUT %i', async (who, searchStatus, addStatus, patchStatus, deleteStatus, putStatus) => {
      const user = ROLE_USERS[who];
      const trip = seedTrip();
      const existing = seedPlace(trip.id, 1, 0);
      directory.catalog.set('g-new', google('g-new'));

      expect((await search(trip.id, 'q=market', user)).status).toBe(searchStatus);
      expect((await add(trip.id, { googlePlaceId: 'g-new' }, user)).status).toBe(addStatus);
      expect((await call('PATCH', `/trips/${trip.id}/places/${existing.id}`, user, { notes: 'x' })).status).toBe(patchStatus);
      const current = db.all(TripPlace, { tripId: trip.id });
      const putBody = { itineraryVersion: version(trip.id), days: [{ day: null, placeIds: current.map((p) => p.id) }] };
      expect((await put(trip.id, putBody, user)).status).toBe(putStatus);
      expect((await call('DELETE', `/trips/${trip.id}/places/${existing.id}`, user)).status).toBe(deleteStatus);
    });

    it('lets every member read the itinerary, with its version; outsiders get 404', async () => {
      const trip = seedTrip({ itineraryVersion: 7 });
      seedPlace(trip.id, 1, 0);

      for (const user of [OWNER, EDITOR, VIEWER]) {
        const response = await call('GET', `/trips/${trip.id}/places`, user);
        expect(response.status).toBe(200);
        expect(await json<ItineraryDto>(response)).toMatchObject({ itineraryVersion: 7, places: [expect.any(Object)] });
      }
      expect((await call('GET', `/trips/${trip.id}/places`, OUTSIDER)).status).toBe(404);
    });

    it('orders the listing by day (Unplanned last), then position', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, null, 0, { googlePlaceId: 'u0' });
      seedPlace(trip.id, 2, 1, { googlePlaceId: 'd2p1' });
      seedPlace(trip.id, 1, 0, { googlePlaceId: 'd1p0' });
      seedPlace(trip.id, 2, 0, { googlePlaceId: 'd2p0' });

      const { places } = await json<ItineraryDto>(await call('GET', `/trips/${trip.id}/places`, VIEWER));

      expect(places.map((p) => p.googlePlaceId)).toEqual(['d1p0', 'd2p0', 'd2p1', 'u0']);
    });
  });

  describe('POST /trips/:id/places', () => {
    it("saves Google's data from Place Details (in the request's language), appended at the end of its day", async () => {
      const trip = seedTrip();
      seedPlace(trip.id, 2, 0);
      seedPlace(trip.id, 2, 1);
      directory.catalog.set('g-1', google('g-1', { types: ['museum', 'tourist_attraction'], rating: 4.7 }));

      const response = await add(trip.id, { googlePlaceId: 'g-1', day: 2, startTime: '09:30', notes: 'Book ahead' }, EDITOR, {
        'accept-language': 'pt-BR',
      });

      expect(response.status).toBe(201);
      expect(await json<TripPlaceDto>(response)).toEqual({
        id: expect.any(String),
        googlePlaceId: 'g-1',
        name: 'Google name g-1',
        address: 'Rua g-1, Lisboa',
        lat: near().lat,
        lng: near().lng,
        rating: 4.7,
        mapsUrl: 'https://maps.google.com/?cid=g-1',
        types: ['museum', 'tourist_attraction'],
        category: 'sight',
        day: 2,
        position: 2,
        startTime: '09:30',
        notes: 'Book ahead',
        source: 'user',
        createdAt: expect.any(String),
      });
      expect(directory.detailsCalls).toEqual([['g-1', 'pt-BR']]);
      expect(db.all(TripPlace, { googlePlaceId: 'g-1' })[0].createdBy).toBe(EDITOR);
    });

    it('puts a place without a day at the end of Unplanned', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, null, 0);
      directory.catalog.set('g-1', google('g-1'));

      expect(await json<TripPlaceDto>(await add(trip.id, { googlePlaceId: 'g-1' }))).toMatchObject({ day: null, position: 1 });
    });

    it('is VALIDATION when Google does not know the place', async () => {
      const trip = seedTrip();

      const response = await add(trip.id, { googlePlaceId: 'g-unknown' });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION', fields: { googlePlaceId: 'Place not found' } });
      expect(db.all(TripPlace)).toEqual([]);
    });

    it('applies the 50 km rule around the destination centre', async () => {
      const trip = seedTrip();
      // ~45 km and ~56 km north of the centre.
      directory.catalog.set('g-near', google('g-near', { location: near(0.405, 0) }));
      directory.catalog.set('g-far', google('g-far', { location: near(0.5, 0) }));

      const far = await add(trip.id, { googlePlaceId: 'g-far' });

      expect(far.status).toBe(400);
      expect(await far.json()).toMatchObject({ code: 'VALIDATION', fields: { googlePlaceId: expect.stringContaining('50 km') } });
      expect((await add(trip.id, { googlePlaceId: 'g-near' })).status).toBe(201);
    });

    it('is 503 AI_UNAVAILABLE when Google fails, and adds nothing', async () => {
      const trip = seedTrip();
      directory.failDetails = true;

      const response = await add(trip.id, { googlePlaceId: 'g-1' });

      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('AI_UNAVAILABLE');
      expect(db.all(TripPlace)).toEqual([]);
    });

    it('is CONFLICT for a place already in the trip, without calling Google', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, 1, 0, { googlePlaceId: 'g-dup' });

      const response = await add(trip.id, { googlePlaceId: 'g-dup' });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'CONFLICT', message: 'Already in this trip' });
      expect(directory.detailsCalls).toEqual([]);
    });

    it('is CONFLICT when two adds of the same place race', async () => {
      const trip = seedTrip();
      directory.catalog.set('g-1', google('g-1'));
      const both = barrier(2);
      // Both requests pass the cheap duplicate check before either inserts.
      db.afterRead = async (entity) => {
        if (entity === TripPlace) await both();
      };

      const statuses = (await Promise.all([add(trip.id, { googlePlaceId: 'g-1' }), add(trip.id, { googlePlaceId: 'g-1' }, EDITOR)])).map(
        (r) => r.status,
      );

      expect(statuses.sort()).toEqual([201, 409]);
      expect(db.all(TripPlace)).toHaveLength(1);
    });

    it.each<[string[], PlaceCategory]>([
      [['restaurant', 'food'], 'food'],
      [['italian_restaurant', 'restaurant'], 'food'],
      [['cafe'], 'food'],
      [['bakery'], 'food'],
      [['tourist_attraction'], 'sight'],
      [['museum'], 'sight'],
      [['historical_landmark'], 'sight'],
      [['park'], 'nature'],
      [['night_club'], 'nightlife'],
      [['shopping_mall'], 'shopping'],
      [['book_store'], 'shopping'],
      [['amusement_park'], 'activity'],
      [['lodging', 'hotel'], 'stay'],
      [['point_of_interest', 'establishment'], 'other'],
      [[], 'other'],
    ])('derives the category from Google types %j → %s', async (types, category) => {
      const trip = seedTrip();
      directory.catalog.set('g-1', google('g-1', { types }));

      expect(await json<TripPlaceDto>(await add(trip.id, { googlePlaceId: 'g-1' }))).toMatchObject({ category });
    });

    it("keeps the client's category when one is given", async () => {
      const trip = seedTrip();
      directory.catalog.set('g-1', google('g-1', { types: ['restaurant'] }));

      expect(await json<TripPlaceDto>(await add(trip.id, { googlePlaceId: 'g-1', category: 'nightlife' }))).toMatchObject({
        category: 'nightlife',
      });
    });

    it('holds at most 200 places', async () => {
      const trip = seedTrip();
      for (let i = 0; i < 200; i += 1) seedPlace(trip.id, null, i);
      directory.catalog.set('g-201', google('g-201'));

      const response = await add(trip.id, { googlePlaceId: 'g-201' });

      expect(response.status).toBe(409);
      expect((await response.json()).message).toContain('200');
      expect(db.all(TripPlace)).toHaveLength(200);
      expect(directory.detailsCalls).toEqual([]);
    });

    it.each([
      ['a day beyond the trip', { day: 4 }, 'day'],
      ['day 0', { day: 0 }, 'day'],
      ['a fractional day', { day: 1.5 }, 'day'],
      ['a 24-hour time out of range', { startTime: '24:00' }, 'startTime'],
      ['a time with seconds', { startTime: '09:30:00' }, 'startTime'],
      ['a 12-hour time', { startTime: '9:30' }, 'startTime'],
      ['a 501-character note', { notes: 'x'.repeat(501) }, 'notes'],
      ['a control character in the note', { notes: 'a\u0000b' }, 'notes'],
      ['an unknown category', { category: 'museum' }, 'category'],
      ['an empty place id', { googlePlaceId: ' ' }, 'googlePlaceId'],
      ['an unknown field', { source: 'ai' }, 'source'],
    ])('rejects %s with VALIDATION', async (_label, body, field) => {
      const trip = seedTrip();
      directory.catalog.set('g-1', google('g-1'));

      const response = await add(trip.id, { googlePlaceId: 'g-1', ...body });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION', fields: { [field]: expect.any(String) } });
      expect(db.all(TripPlace)).toEqual([]);
    });
  });

  describe('GET /trips/:id/places/search', () => {
    it('returns at most 10 results near the destination, flagged when already in the trip', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, 1, 0, { googlePlaceId: 'g-3' });
      for (let i = 1; i <= 12; i += 1) {
        directory.catalog.set(`g-${i}`, google(`g-${i}`, { types: i === 1 ? ['restaurant'] : ['point_of_interest'] }));
      }

      const response = await search(trip.id, 'q=  pastel de nata  &category=food', EDITOR, { 'accept-language': 'es' });

      expect(response.status).toBe(200);
      const { results } = await json<{ results: PlaceSearchResultDto[] }>(response);
      expect(results).toHaveLength(10);
      expect(results[0]).toEqual({
        googlePlaceId: 'g-1',
        name: 'Google name g-1',
        address: 'Rua g-1, Lisboa',
        lat: near().lat,
        lng: near().lng,
        rating: 4.5,
        types: ['restaurant'],
        suggestedCategory: 'food',
        alreadyInTrip: false,
      });
      // No type maps to a category: the category filter suggests one.
      expect(results[1].suggestedCategory).toBe('food');
      expect(results.find((r) => r.googlePlaceId === 'g-3')?.alreadyInTrip).toBe(true);
      expect(directory.searchManyCalls).toEqual([
        {
          query: 'pastel de nata',
          languageCode: 'es',
          limit: 10,
          includedType: 'restaurant',
          near: { center: expect.objectContaining({ lat: expect.any(Number) }), radiusMeters: 50_000 },
        },
      ]);
    });

    it('caches the destination centre per trip', async () => {
      const trip = seedTrip();

      await search(trip.id, 'q=a');
      await search(trip.id, 'q=b');

      expect(directory.searchTextCalls.filter((s) => s.query === 'Lisbon')).toHaveLength(1);
      expect(directory.searchManyCalls).toHaveLength(2);
    });

    it('sends no type hint without a category, and is 503 when Google fails', async () => {
      const trip = seedTrip();

      await search(trip.id, 'q=anything');
      directory.failSearch = true;
      const failed = await search(trip.id, 'q=anything');

      expect(directory.searchManyCalls[0]).not.toHaveProperty('includedType', expect.anything());
      expect(failed.status).toBe(503);
      expect((await failed.json()).code).toBe('AI_UNAVAILABLE');
    });

    it.each([
      ['no q', ''],
      ['an empty q', 'q=%20'],
      ['a 101-character q', `q=${'x'.repeat(101)}`],
      ['an unknown category', 'q=x&category=museum'],
      ['an unknown parameter', 'q=x&limit=50'],
    ])('rejects %s with VALIDATION', async (_label, query) => {
      const trip = seedTrip();

      const response = await search(trip.id, query);

      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('VALIDATION');
      expect(directory.searchManyCalls).toEqual([]);
    });

    it('allows 60 searches per user per hour, then RATE_LIMITED with Retry-After', async () => {
      const trip = seedTrip();
      for (let i = 0; i < 60; i += 1) expect((await search(trip.id, `q=s${i}`)).status).toBe(200);

      const limited = await search(trip.id, 'q=one-more');

      expect(limited.status).toBe(429);
      expect((await limited.json()).code).toBe('RATE_LIMITED');
      const retryAfter = Number(limited.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(3500);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(directory.searchManyCalls).toHaveLength(60);
      // Per user: the editor still can.
      expect((await search(trip.id, 'q=editor', EDITOR)).status).toBe(200);
    });

    it('frees a slot once the oldest search leaves the hour', async () => {
      const trip = seedTrip();
      // 60 searches, the oldest about to leave the rolling hour.
      const searches = (moduleRef.get(ItineraryService) as unknown as { searches: Map<string, number[]> }).searches;
      const oldest = Date.now() - 60 * 60 * 1000 + 300;
      searches.set(OWNER, [oldest, ...Array.from({ length: 59 }, () => Date.now())]);

      const limited = await search(trip.id, 'q=late');
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect((await search(trip.id, 'q=later')).status).toBe(200);
    });
  });

  describe('PATCH /trips/:id/places/:placeId', () => {
    it('changes category, start time and note; null clears time and note; the version stays', async () => {
      const trip = seedTrip({ itineraryVersion: 3 });
      const place = seedPlace(trip.id, 1, 0, { notes: 'old', startTime: '10:00' });

      const changed = await call('PATCH', `/trips/${trip.id}/places/${place.id}`, EDITOR, { category: 'food', startTime: '19:45', notes: 'Dinner' });
      expect(changed.status).toBe(200);
      expect(await json<TripPlaceDto>(changed)).toMatchObject({ category: 'food', startTime: '19:45', notes: 'Dinner', day: 1, position: 0 });

      const cleared = await json<TripPlaceDto>(await call('PATCH', `/trips/${trip.id}/places/${place.id}`, OWNER, { startTime: null, notes: null }));
      expect(cleared).toMatchObject({ category: 'food', startTime: null, notes: null });
      expect(version(trip.id)).toBe(3);
    });

    it.each([
      ['category: null', { category: null }, 'category'],
      ['a bad time', { startTime: '7pm' }, 'startTime'],
      ['a day (moves go through PUT)', { day: 2 }, 'day'],
    ])('rejects %s', async (_label, body, field) => {
      const trip = seedTrip();
      const place = seedPlace(trip.id, 1, 0);

      const response = await call('PATCH', `/trips/${trip.id}/places/${place.id}`, OWNER, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ fields: { [field]: expect.any(String) } });
    });

    it("is NOT_FOUND for an unknown place, or another trip's", async () => {
      const trip = seedTrip();
      const other = seedTrip();
      const elsewhere = seedPlace(other.id, 1, 0);

      expect((await call('PATCH', `/trips/${trip.id}/places/${randomUUID()}`, OWNER, { notes: 'x' })).status).toBe(404);
      expect((await call('PATCH', `/trips/${trip.id}/places/${elsewhere.id}`, OWNER, { notes: 'x' })).status).toBe(404);
      expect((await call('PATCH', `/trips/${trip.id}/places/nope`, OWNER, { notes: 'x' })).status).toBe(404);
    });
  });

  describe('DELETE /trips/:id/places/:placeId', () => {
    it('moves the later places of the day up and bumps the version', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, 1, 0, { googlePlaceId: 'a' });
      const b = seedPlace(trip.id, 1, 1, { googlePlaceId: 'b' });
      seedPlace(trip.id, 1, 2, { googlePlaceId: 'c' });
      seedPlace(trip.id, 2, 0, { googlePlaceId: 'd' });

      expect((await call('DELETE', `/trips/${trip.id}/places/${b.id}`, EDITOR)).status).toBe(204);

      expect(order(trip.id)).toEqual([
        ['a', 1, 0],
        ['c', 1, 1],
        ['d', 2, 0],
      ]);
      expect(version(trip.id)).toBe(1);
    });
  });

  describe('PUT /trips/:id/itinerary', () => {
    function threePlaces() {
      const trip = seedTrip({ itineraryVersion: 4 });
      const a = seedPlace(trip.id, 1, 0, { googlePlaceId: 'a' });
      const b = seedPlace(trip.id, 1, 1, { googlePlaceId: 'b' });
      const c = seedPlace(trip.id, null, 0, { googlePlaceId: 'c' });
      return { trip, a, b, c };
    }

    it('applies a reorder across days, positions 0…n-1, and bumps the version', async () => {
      const { trip, a, b, c } = threePlaces();

      const response = await put(trip.id, {
        itineraryVersion: 4,
        days: [
          { day: 1, placeIds: [b.id] },
          { day: 3, placeIds: [c.id, a.id] },
          { day: null, placeIds: [] },
        ],
      });

      expect(response.status).toBe(200);
      const body = await json<ItineraryDto>(response);
      expect(body.itineraryVersion).toBe(5);
      expect(body.places.map((p) => [p.googlePlaceId, p.day, p.position])).toEqual([
        ['b', 1, 0],
        ['c', 3, 0],
        ['a', 3, 1],
      ]);
      expect(order(trip.id)).toEqual([
        ['b', 1, 0],
        ['c', 3, 0],
        ['a', 3, 1],
      ]);
      expect(version(trip.id)).toBe(5);
    });

    it.each([
      ['a missing place', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 1, placeIds: [p.a.id, p.b.id] }]],
      ['an extra (unknown) place', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 1, placeIds: [p.a.id, p.b.id, p.c.id, randomUUID()] }]],
      ['a duplicate place', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 1, placeIds: [p.a.id, p.b.id] }, { day: 2, placeIds: [p.c.id, p.a.id] }]],
      ['a day beyond the trip', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 4, placeIds: [p.a.id, p.b.id, p.c.id] }]],
      ['day 0', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 0, placeIds: [p.a.id, p.b.id, p.c.id] }]],
      ['the same day twice', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 1, placeIds: [p.a.id] }, { day: 1, placeIds: [p.b.id, p.c.id] }]],
      ['a group without a day', (p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ placeIds: [p.a.id, p.b.id, p.c.id] }]],
      ['a malformed id', (_p: { a: TripPlace; b: TripPlace; c: TripPlace }) => [{ day: 1, placeIds: ['nope'] }]],
    ])('rejects %s with VALIDATION and changes nothing', async (_label, days) => {
      const places = threePlaces();
      const before = order(places.trip.id);

      const response = await put(places.trip.id, { itineraryVersion: 4, days: days(places) });

      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('VALIDATION');
      expect(order(places.trip.id)).toEqual(before);
      expect(version(places.trip.id)).toBe(4);
    });

    it('is CONFLICT with the current version when the version is stale', async () => {
      const { trip, a, b, c } = threePlaces();

      const response = await put(trip.id, { itineraryVersion: 3, days: [{ day: 2, placeIds: [a.id, b.id, c.id] }] });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'CONFLICT', fields: { itineraryVersion: '4' } });
      expect(version(trip.id)).toBe(4);
      expect(order(trip.id)).toEqual([
        ['a', 1, 0],
        ['b', 1, 1],
        ['c', null, 0],
      ]);
    });

    it('lets exactly one of two concurrent PUTs at the same version through', async () => {
      const { trip, a, b, c } = threePlaces();
      const both = barrier(2);
      // Both pass the membership check before either takes the trip lock.
      db.afterRead = async (entity) => {
        if (entity === TripMember) await both();
      };

      const responses = await Promise.all([
        put(trip.id, { itineraryVersion: 4, days: [{ day: 2, placeIds: [a.id, b.id, c.id] }] }),
        put(trip.id, { itineraryVersion: 4, days: [{ day: 3, placeIds: [c.id, b.id, a.id] }] }, EDITOR),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(version(trip.id)).toBe(5);
      const days = new Set(db.all(TripPlace, { tripId: trip.id }).map((p) => p.day));
      expect(days.size).toBe(1);
    });
  });

  describe('trip date changes', () => {
    it('moves places on days that no longer exist to the end of Unplanned, in order, and bumps the version', async () => {
      const trip = seedTrip();
      seedPlace(trip.id, 1, 0, { googlePlaceId: 'd1' });
      seedPlace(trip.id, 2, 0, { googlePlaceId: 'd2a' });
      seedPlace(trip.id, 2, 1, { googlePlaceId: 'd2b' });
      seedPlace(trip.id, 3, 0, { googlePlaceId: 'd3' });
      seedPlace(trip.id, null, 0, { googlePlaceId: 'u' });

      const response = await call('PATCH', `/trips/${trip.id}`, OWNER, { endDate: '2026-11-10' });

      expect(response.status).toBe(200);
      expect(order(trip.id)).toEqual([
        ['d1', 1, 0],
        ['u', null, 0],
        ['d2a', null, 1],
        ['d2b', null, 2],
        ['d3', null, 3],
      ]);
      expect(version(trip.id)).toBe(1);
    });

    it('changes nothing (and keeps the version) when every day still exists', async () => {
      const trip = seedTrip({ itineraryVersion: 2 });
      seedPlace(trip.id, 3, 0, { googlePlaceId: 'd3' });

      await call('PATCH', `/trips/${trip.id}`, OWNER, { endDate: '2026-11-20' });
      await call('PATCH', `/trips/${trip.id}`, OWNER, { notes: 'not a date change' });

      expect(order(trip.id)).toEqual([['d3', 3, 0]]);
      expect(version(trip.id)).toBe(2);
    });

    it('never writes a stale version back on a trip update', async () => {
      const trip = seedTrip({ itineraryVersion: 2 });
      // Another request bumps the version after this one loaded the trip.
      let reads = 0;
      db.afterRead = async (entity) => {
        if (entity === TripMember && ++reads === 1) await db.manager(null).update(Trip, { id: trip.id }, { itineraryVersion: 9 });
      };

      expect((await call('PATCH', `/trips/${trip.id}`, OWNER, { notes: 'x' })).status).toBe(200);
      expect(version(trip.id)).toBe(9);
    });
  });

  describe('the version goes up on every kind of itinerary change', () => {
    it('add, delete, PUT and date change: +1 each; PATCH of a place: no change', async () => {
      const trip = seedTrip();
      directory.catalog.set('g-1', google('g-1'));

      const added = await json<TripPlaceDto>(await add(trip.id, { googlePlaceId: 'g-1', day: 3 }));
      expect(version(trip.id)).toBe(1);
      await call('PATCH', `/trips/${trip.id}/places/${added.id}`, OWNER, { notes: 'x' });
      expect(version(trip.id)).toBe(1);
      await put(trip.id, { itineraryVersion: 1, days: [{ day: 3, placeIds: [added.id] }] });
      expect(version(trip.id)).toBe(2);
      await call('PATCH', `/trips/${trip.id}`, OWNER, { endDate: '2026-11-11' });
      expect(version(trip.id)).toBe(3);
      await call('DELETE', `/trips/${trip.id}/places/${added.id}`, OWNER);
      expect(version(trip.id)).toBe(4);
    });
  });

  describe('selective AI confirm (placeIds)', () => {
    type Confirmed = AppTripDto & { added: number; skipped: number };

    /** A linked conversation whose ready draft proposes Old Town (day 1), Central Market (day 1) and City Park (day 2). */
    async function linkedDraft(tripId: string) {
      const response = await call('POST', '/ai/conversations', OWNER, {
        message: 'Places to visit in Lisbon from 2026-11-10 to 2026-11-12',
        tripId,
      });
      expect(response.status).toBe(201);
      const { conversation, turn } = await json<{ conversation: AiConversationDto; turn: AiTurnDto }>(response);
      const idOf = (name: string) => turn.draft!.places.find((p) => p.name.includes(name))!.place!.googlePlaceId;
      expect(turn.draft!.places.every((p) => p.verified)).toBe(true);
      return { conversationId: conversation.id, oldTown: idOf('Old Town'), market: idOf('Central Market'), park: idOf('City Park') };
    }
    const confirm = (conversationId: string, body: unknown = {}) => call('POST', `/ai/conversations/${conversationId}/confirm`, OWNER, body);

    it('adds only the chosen places, on their days after what is there, skipping ones already in the trip', async () => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);
      seedPlace(trip.id, 2, 0, { googlePlaceId: 'existing-day-2' });
      seedPlace(trip.id, 1, 0, { googlePlaceId: draft.oldTown });

      const response = await confirm(draft.conversationId, { placeIds: [draft.oldTown, draft.park] });

      expect(response.status).toBe(200);
      const body = await json<Confirmed>(response);
      expect(body).toMatchObject({ id: trip.id, destination: 'Lisbon', added: 1, skipped: 1 });
      expect(order(trip.id)).toEqual([
        [draft.oldTown, 1, 0],
        ['existing-day-2', 2, 0],
        [draft.park, 2, 1],
      ]);
      expect(db.all(TripPlace, { googlePlaceId: draft.market })).toEqual([]);
      expect(db.all(TripPlace, { googlePlaceId: draft.park })[0]).toMatchObject({ source: 'ai', category: 'nature', createdBy: OWNER });
      expect(version(trip.id)).toBe(1);
    });

    it('adds every verified place without placeIds (today’s behaviour)', async () => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);

      const body = await json<Confirmed>(await confirm(draft.conversationId));

      expect(body).toMatchObject({ added: 3, skipped: 0 });
      expect(order(trip.id)).toEqual([
        [draft.oldTown, 1, 0],
        [draft.market, 1, 1],
        [draft.park, 2, 0],
      ]);
    });

    it('puts a place whose suggested day the trip does not have in Unplanned', async () => {
      const trip = seedTrip({ endDate: '2026-11-10' });
      const draft = await linkedDraft(trip.id);

      await confirm(draft.conversationId, { placeIds: [draft.park] });

      expect(order(trip.id)).toEqual([[draft.park, null, 0]]);
    });

    it("rejects an id that isn't a verified place of the draft, and changes nothing", async () => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);

      const response = await confirm(draft.conversationId, { placeIds: [draft.park, 'g-not-in-draft'] });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION', fields: { placeIds: expect.any(String) } });
      expect(db.all(TripPlace)).toEqual([]);
      expect(db.all(AiConversation)[0].status).toBe('open');
      expect(version(trip.id)).toBe(0);
    });

    it.each([
      ['not an array', { placeIds: 'abc' }],
      ['an empty id', { placeIds: [''] }],
      ['an unknown field', { places: [] }],
    ])('rejects a body with %s', async (_label, body) => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);

      expect((await confirm(draft.conversationId, body)).status).toBe(400);
    });

    it('accepts an empty selection (nothing added, version unchanged), and is idempotent afterwards', async () => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);

      expect(await json<Confirmed>(await confirm(draft.conversationId, { placeIds: [] }))).toMatchObject({ added: 0, skipped: 0 });
      expect(await json<Confirmed>(await confirm(draft.conversationId, { placeIds: [draft.park] }))).toMatchObject({ added: 0, skipped: 0 });
      expect(db.all(TripPlace)).toEqual([]);
      expect(version(trip.id)).toBe(0);
    });

    it('skips what would go over the 200-place cap', async () => {
      const trip = seedTrip();
      const draft = await linkedDraft(trip.id);
      for (let i = 0; i < 199; i += 1) seedPlace(trip.id, null, i);

      expect(await json<Confirmed>(await confirm(draft.conversationId))).toMatchObject({ added: 1, skipped: 2 });
      expect(db.all(TripPlace, { tripId: trip.id })).toHaveLength(200);
    });

    it('creates a new trip with only the chosen places (201)', async () => {
      const started = await json<{ conversation: AiConversationDto; turn: AiTurnDto }>(
        await call('POST', '/ai/conversations', OWNER, { message: 'A trip to Lisbon from 2026-11-10 to 2026-11-12 for 2 people' }),
      );
      const park = started.turn.draft!.places.find((p) => p.name.includes('City Park'))!.place!.googlePlaceId;

      const response = await confirm(started.conversation.id, { placeIds: [park] });

      expect(response.status).toBe(201);
      const body = await json<Confirmed>(response);
      expect(body).toMatchObject({ myRole: 'owner', added: 1, skipped: 0 });
      expect(order(body.id)).toEqual([[park, 2, 0]]);
      expect(version(body.id)).toBe(1);
    });
  });
});

