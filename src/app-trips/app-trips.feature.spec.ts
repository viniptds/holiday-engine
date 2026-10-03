import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripsModule } from './app-trips.module.js';
import type { AppTripDto, TripRole } from './app-trips.types.js';
import { QUESTION_SET } from '../wizard/wizard.types.js';
import { appDb } from '../testing/app-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';
import { TEST_QUESTIONS as QUESTIONS } from '../testing/wizard-questions.js';

/**
 * In-memory stand-in for the two repositories, covering exactly the calls `AppTripsService`
 * makes. Reads return copies, so unsaved changes never leak into the store, and the
 * transaction restores the store when its work throws.
 */
class FakeDb {
  trips = new Map<string, Trip>();
  members: TripMember[] = [];
  failNextMemberInsert = false;

  private copyTrip = (trip: Trip) => Object.assign(new Trip(), structuredClone({ ...trip }));
  private withTrip = (member: TripMember) =>
    Object.assign(new TripMember(), member, { trip: this.copyTrip(this.trips.get(member.tripId)!) });

  private insert(entity: object) {
    if (entity instanceof Trip) {
      const now = new Date();
      Object.assign(entity, { id: randomUUID(), createdAt: now, updatedAt: now });
      this.trips.set(entity.id, this.copyTrip(entity));
    } else if (entity instanceof TripMember) {
      if (this.failNextMemberInsert) {
        this.failNextMemberInsert = false;
        throw new Error('insert failed');
      }
      Object.assign(entity, { joinedAt: entity.joinedAt ?? new Date() });
      this.members.push(Object.assign(new TripMember(), entity));
    }
    return entity;
  }

  tripsRepo = {
    save: async (trip: Trip) => {
      trip.updatedAt = new Date();
      this.trips.set(trip.id, this.copyTrip(trip));
      return trip;
    },
    delete: async ({ id }: { id: string }) => {
      this.trips.delete(id);
      this.members = this.members.filter((m) => m.tripId !== id); // ON DELETE CASCADE
    },
    manager: {
      transaction: async <T>(work: (manager: unknown) => Promise<T>): Promise<T> => {
        const snapshot = { trips: new Map(this.trips), members: [...this.members] };
        const manager = {
          create: (cls: new () => object, data: object) => Object.assign(new cls(), data),
          save: async (entity: object) => this.insert(entity),
        };
        try {
          return await work(manager);
        } catch (error) {
          Object.assign(this, snapshot);
          throw error;
        }
      },
    },
  };

  membersRepo = {
    find: async ({ where }: { where: { userId?: string; tripId?: FindOperator<string[]> } }) => {
      if (where.userId) {
        return this.members
          .filter((m) => m.userId === where.userId)
          .map(this.withTrip)
          .sort((a, b) => a.trip!.startDate.localeCompare(b.trip!.startDate));
      }
      const ids = where.tripId!.value as string[];
      return this.members.filter((m) => ids.includes(m.tripId)).map((m) => Object.assign(new TripMember(), m));
    },
    findOne: async ({ where }: { where: { tripId: string; userId: string } }) => {
      const member = this.members.find((m) => m.tripId === where.tripId && m.userId === where.userId);
      return member ? this.withTrip(member) : null;
    },
  };

  /** A trip owned by `owner`, with the other members joining a minute apart. */
  seed(owner: string, others: [string, TripRole][] = [], fields: Partial<Trip> = {}): string {
    const trip = this.insert(
      Object.assign(new Trip(), {
        provider: null,
        chatId: null,
        ownerUserId: owner,
        destination: 'Lisbon',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        notes: 'pack light',
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
        ...fields,
      }),
    ) as Trip;
    [[owner, 'owner'] as [string, TripRole], ...others].forEach(([userId, role], i) =>
      this.insert(
        Object.assign(new TripMember(), {
          tripId: trip.id,
          userId,
          role,
          joinedAt: new Date(Date.UTC(2026, 9, 3, 10, i)),
        }),
      ),
    );
    return trip.id;
  }
}

const OWNER = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const VIEWER = '33333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OUTSIDER = '44444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS: Record<string, string> = { owner: OWNER, editor: EDITOR, viewer: VIEWER, outsider: OUTSIDER };

describe('App trips API (feature)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let db: FakeDb;
  let tokens: Record<string, string>;

  beforeAll(async () => {
    db = new FakeDb();
    // Users and refresh tokens (for the real AuthGuard) live in the shared fake; trips and members in FakeDb.
    const users = appDb();
    for (const id of Object.values(USERS)) seedUser(users, id);
    const moduleRef = await appTestingModule(users, [AppTripsModule])
      .overrideProvider(getRepositoryToken(Trip))
      .useValue(db.tripsRepo)
      .overrideProvider(getRepositoryToken(TripMember))
      .useValue(db.membersRepo)
      .overrideProvider(QUESTION_SET)
      .useValue(QUESTIONS)
      .compile();
    tokens = await accessTokens(moduleRef, Object.values(USERS));
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.trips.clear();
    db.members = [];
  });

  /** Calls the API as `user`; `language` is sent as `Accept-Language` (none by default). */
  const call = (method: string, path: string, user: string | null, body?: unknown, language?: string) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(language ? { 'accept-language': language } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const sharedTrip = () => db.seed(OWNER, [[EDITOR, 'editor'], [VIEWER, 'viewer']]);
  const valid = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };

  describe('authentication', () => {
    it.each([
      ['GET', '/trips'],
      ['POST', '/trips'],
      ['GET', `/trips/${randomUUID()}`],
      ['PATCH', `/trips/${randomUUID()}`],
      ['DELETE', `/trips/${randomUUID()}`],
    ])('%s %s without a user is 401 UNAUTHENTICATED', async (method, path) => {
      const res = await call(method, path, null, method === 'POST' || method === 'PATCH' ? valid : undefined);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED', message: 'Missing access token' });
    });

    it('rejects an invalid access token', async () => {
      const res = await fetch(`${baseUrl}/trips`, { headers: { authorization: 'Bearer not-a-jwt' } });

      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('UNAUTHENTICATED');
    });

    it('authenticates before validating the body', async () => {
      const res = await call('POST', '/trips', null, {});

      expect(res.status).toBe(401);
    });
  });

  describe('POST /trips', () => {
    it('creates the trip with the caller as owner and returns 201 Trip', async () => {
      const res = await call('POST', '/trips', OWNER, {
        ...valid,
        story: 'Our honeymoon',
        partyType: 'couple',
        partySize: 2,
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] } },
      });

      expect(res.status).toBe(201);
      const trip = (await res.json()) as AppTripDto;
      expect(trip).toEqual({
        id: expect.any(String),
        destination: 'Lisbon',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        notes: null,
        story: 'Our honeymoon',
        partyType: 'couple',
        partySize: 2,
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] }, persona: 'Easygoing Wanderer' },
        myRole: 'owner',
        members: [{ userId: OWNER, displayName: 'Traveler 1111', avatarUrl: null, role: 'owner' }],
        memberCount: 1,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        updatedAt: expect.stringMatching(/Z$/),
      });
      expect(db.trips.get(trip.id)).toMatchObject({
        ownerUserId: OWNER,
        provider: null,
        chatId: null,
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] }, persona: 'relaxer' },
      });
      expect(db.members).toEqual([expect.objectContaining({ tripId: trip.id, userId: OWNER, role: 'owner' })]);
    });

    it('leaves no trip behind when the owner membership fails', async () => {
      db.failNextMemberInsert = true;

      const res = await call('POST', '/trips', OWNER, valid);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ code: 'INTERNAL', message: 'Something went wrong' });
      expect(db.trips.size).toBe(0);
      expect(db.members).toEqual([]);
    });

    it('rejects an invalid body with 400 VALIDATION and per-field messages', async () => {
      const res = await call('POST', '/trips', OWNER, {
        destination: ' ',
        startDate: '2026-01-01',
        endDate: '2027-01-02',
        partyType: 'crew',
        partySize: 0,
        extra: true,
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ code: 'VALIDATION', message: expect.any(String) });
      expect(Object.keys(body.fields).sort()).toEqual(['destination', 'endDate', 'extra', 'partySize', 'partyType']);
      expect(body.fields.endDate).toBe('endDate must be at most 365 days after startDate');
      expect(db.trips.size).toBe(0);
    });
  });

  describe('travelerProfile', () => {
    it('rejects answers outside the question set with 400 and per-answer fields', async () => {
      const res = await call('POST', '/trips', OWNER, {
        ...valid,
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow', 'packed'], mood: ['happy'], interests: ['golf'] } },
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: 'VALIDATION',
        message: 'Some fields are invalid',
        fields: {
          'travelerProfile.answers.pace': 'pace takes exactly 1 option',
          'travelerProfile.answers.mood': 'mood is not a known question',
          'travelerProfile.answers.interests': 'golf is not an option of interests',
        },
      });
      expect(db.trips.size).toBe(0);
    });

    it('recomputes the persona when PATCH changes the profile', async () => {
      const id = sharedTrip();

      const res = await call('PATCH', `/trips/${id}`, EDITOR, {
        travelerProfile: { questionSetVersion: 1, answers: { interests: ['hiking', 'food'], pace: ['packed'] } },
      });

      expect(res.status).toBe(200);
      expect((await res.json()).travelerProfile).toEqual({
        questionSetVersion: 1,
        answers: { interests: ['hiking', 'food'], pace: ['packed'] },
        persona: 'Trail Seeker',
      });
    });
  });

  describe('persona language', () => {
    const profile = (persona: string | null) => ({ questionSetVersion: 1, answers: { pace: ['slow'] }, persona });
    const personaOf = async (res: Response) => ((await res.json()) as AppTripDto).travelerProfile?.persona;

    it('creates with the persona key stored and returns its label in the request language', async () => {
      const res = await call(
        'POST',
        '/trips',
        OWNER,
        { ...valid, travelerProfile: { questionSetVersion: 1, answers: { pace: ['packed'] } } },
        'es-MX,es;q=0.9',
      );

      expect(res.status).toBe(201);
      const trip = (await res.json()) as AppTripDto;
      expect(trip.travelerProfile).toEqual({ questionSetVersion: 1, answers: { pace: ['packed'] }, persona: 'Alma senderista' });
      expect(db.trips.get(trip.id)?.travelerProfile?.persona).toBe('adventurer');
    });

    it.each([
      [undefined, 'Easygoing Wanderer'],
      ['en-US', 'Easygoing Wanderer'],
      ['pt-BR', 'Espírito tranquilo'],
      ['pt-PT', 'Espírito tranquilo'],
      ['es', 'Espíritu tranquilo'],
      ['fr-FR', 'Easygoing Wanderer'],
      ['fr;q=1, es;q=0.5', 'Espíritu tranquilo'],
    ])('follows Accept-Language %p on every Trip response', async (language, label) => {
      const id = db.seed(OWNER, [[EDITOR, 'editor']], { travelerProfile: profile('relaxer') });

      expect(await personaOf(await call('GET', `/trips/${id}`, OWNER, undefined, language))).toBe(label);
      const list = (await (await call('GET', '/trips', OWNER, undefined, language)).json()) as { trips: AppTripDto[] };
      expect(list.trips[0].travelerProfile?.persona).toBe(label);
      expect(await personaOf(await call('PATCH', `/trips/${id}`, EDITOR, { notes: 'x' }, language))).toBe(label);
    });

    it('maps a row holding the old English label back to its key, in the request language', async () => {
      const id = db.seed(OWNER, [], { travelerProfile: profile('Taste Hunter') });

      expect(await personaOf(await call('GET', `/trips/${id}`, OWNER, undefined, 'pt-BR'))).toBe('Paladar aventureiro');
      expect(await personaOf(await call('GET', `/trips/${id}`, OWNER, undefined, 'en'))).toBe('Taste Hunter');
      expect(db.trips.get(id)?.travelerProfile?.persona).toBe('Taste Hunter'); // reads don't write

      // Any save rewrites it to the key.
      expect(await personaOf(await call('PATCH', `/trips/${id}`, OWNER, { notes: 'x' }, 'es'))).toBe('Paladar aventurero');
      expect(db.trips.get(id)?.travelerProfile?.persona).toBe('foodie');
    });

    it('returns an unknown stored persona as null and leaves it stored', async () => {
      const id = db.seed(OWNER, [], { travelerProfile: profile('Retired Persona') });

      expect(await personaOf(await call('GET', `/trips/${id}`, OWNER, undefined, 'es'))).toBeNull();
      expect(await personaOf(await call('PATCH', `/trips/${id}`, OWNER, { notes: 'x' }))).toBeNull();
      expect(db.trips.get(id)?.travelerProfile?.persona).toBe('Retired Persona');
    });
  });

  describe('GET /trips', () => {
    it('lists only the trips the caller is a member of, by startDate, with my role', async () => {
      const later = db.seed(OWNER, [[VIEWER, 'viewer']], { destination: 'Porto', startDate: '2026-12-01', endDate: '2026-12-03' });
      const earlier = db.seed(EDITOR, [[VIEWER, 'editor']], { destination: 'Rome', startDate: '2026-10-10', endDate: '2026-10-12' });
      db.seed(OUTSIDER);

      const res = await call('GET', '/trips', VIEWER);

      expect(res.status).toBe(200);
      const { trips } = (await res.json()) as { trips: AppTripDto[] };
      expect(trips.map((t) => [t.id, t.destination, t.myRole])).toEqual([
        [earlier, 'Rome', 'editor'],
        [later, 'Porto', 'viewer'],
      ]);
      expect(trips[0].members.map((m) => m.role)).toEqual(['owner', 'editor']);
    });

    it('returns an empty list for a user with no trips', async () => {
      sharedTrip();

      const res = await call('GET', '/trips', OUTSIDER);

      expect(await res.json()).toEqual({ trips: [] });
    });

    it('previews the first 5 members, owner first, and counts them all', async () => {
      const others = Array.from({ length: 6 }, (_, i): [string, TripRole] => [randomUUID(), i % 2 ? 'viewer' : 'editor']);
      db.seed(OWNER, others);

      const [trip] = ((await (await call('GET', '/trips', OWNER)).json()) as { trips: AppTripDto[] }).trips;

      expect(trip.memberCount).toBe(7);
      expect(trip.members.map((m) => m.userId)).toEqual([OWNER, ...others.slice(0, 4).map(([id]) => id)]);
    });
  });

  // Who may do what (contract): GET member; PATCH owner/editor; DELETE owner; non-members get 404.
  describe.each([
    ['owner', 200, 200, 204],
    ['editor', 200, 200, 403],
    ['viewer', 200, 403, 403],
    ['outsider', 404, 404, 404],
  ])('as %s', (who, getStatus, patchStatus, deleteStatus) => {
    const user = () => USERS[who];

    it(`GET /trips/:id is ${getStatus}`, async () => {
      const id = sharedTrip();

      const res = await call('GET', `/trips/${id}`, user());

      expect(res.status).toBe(getStatus);
      const body = await res.json();
      if (getStatus === 200) {
        expect(body).toMatchObject({ id, myRole: who, memberCount: 3 });
        expect(body.members.map((m: { userId: string }) => m.userId)).toEqual([OWNER, EDITOR, VIEWER]);
      } else {
        expect(body).toEqual({ code: 'NOT_FOUND', message: 'Trip not found' });
      }
    });

    it(`PATCH /trips/:id is ${patchStatus}`, async () => {
      const id = sharedTrip();

      const res = await call('PATCH', `/trips/${id}`, user(), { destination: 'Porto' });

      expect(res.status).toBe(patchStatus);
      const body = await res.json();
      if (patchStatus === 200) {
        expect(body).toMatchObject({ id, destination: 'Porto', myRole: who });
        expect(db.trips.get(id)?.destination).toBe('Porto');
      } else {
        expect(body.code).toBe(patchStatus === 403 ? 'FORBIDDEN' : 'NOT_FOUND');
        expect(db.trips.get(id)?.destination).toBe('Lisbon');
      }
    });

    it(`DELETE /trips/:id is ${deleteStatus}`, async () => {
      const id = sharedTrip();

      const res = await call('DELETE', `/trips/${id}`, user());

      expect(res.status).toBe(deleteStatus);
      if (deleteStatus === 204) {
        expect(await res.text()).toBe('');
        expect(db.trips.has(id)).toBe(false);
        expect(db.members.filter((m) => m.tripId === id)).toEqual([]);
      } else {
        expect((await res.json()).code).toBe(deleteStatus === 403 ? 'FORBIDDEN' : 'NOT_FOUND');
        expect(db.trips.has(id)).toBe(true);
      }
    });
  });

  describe('PATCH /trips/:id', () => {
    it('clears the nullable fields with null and keeps omitted ones', async () => {
      const id = db.seed(OWNER, [], {
        story: 'old',
        partyType: 'solo',
        partySize: 1,
        travelerProfile: { questionSetVersion: 1, answers: {}, persona: null },
      });

      const res = await call('PATCH', `/trips/${id}`, OWNER, {
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        destination: 'Lisbon',
        startDate: '2026-11-01',
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
      });
    });

    it.each(['destination', 'startDate', 'endDate'])('rejects %s: null with 400', async (field) => {
      const id = sharedTrip();

      const res = await call('PATCH', `/trips/${id}`, OWNER, { [field]: null });

      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'VALIDATION', fields: { [field]: expect.any(String) } });
    });

    it('applies date order and the 365-day cap against the stored dates', async () => {
      const id = sharedTrip();

      const reversed = await call('PATCH', `/trips/${id}`, EDITOR, { endDate: '2026-10-31' });
      const tooLong = await call('PATCH', `/trips/${id}`, EDITOR, { startDate: '2025-11-04' });

      expect(reversed.status).toBe(400);
      expect(await reversed.json()).toMatchObject({ fields: { endDate: 'endDate must be on or after startDate' } });
      expect(tooLong.status).toBe(400);
      expect(await tooLong.json()).toMatchObject({
        fields: { startDate: 'endDate must be at most 365 days after startDate' },
      });
      expect(db.trips.get(id)).toMatchObject({ startDate: '2026-11-01', endDate: '2026-11-05' });
    });

    it('bumps updatedAt', async () => {
      const id = sharedTrip();
      const before = db.trips.get(id)!.updatedAt;
      await new Promise((resolve) => setTimeout(resolve, 5));

      const body = (await (await call('PATCH', `/trips/${id}`, OWNER, { notes: 'x' })).json()) as AppTripDto;

      expect(Date.parse(body.updatedAt)).toBeGreaterThan(before.getTime());
    });
  });

  it.each(['GET', 'PATCH', 'DELETE'])('%s with a malformed trip id is 404', async (method) => {
    const res = await call(method, '/trips/not-a-uuid', OWNER, method === 'PATCH' ? { notes: 'x' } : undefined);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NOT_FOUND');
  });
});
