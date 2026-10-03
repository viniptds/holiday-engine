import { randomBytes, randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { AppTripDto, TripRole } from '../app-trips/app-trips.types.js';
import { appDb } from '../testing/app-db.js';
import { barrier } from '../testing/in-memory-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from '../auth/refresh-token.entity.js';
import { RefreshTokenService } from '../auth/refresh-token.service.js';
import { TripInvite } from './trip-invite.entity.js';
import { MembersModule } from './members.module.js';
import { MembersService } from './members.service.js';
import { hashToken } from './invites.service.js';
import { LoggingInviteMailer } from './invite-mailer.js';
import type { InviteDto, MemberDto } from './members.types.js';

const OWNER = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const VIEWER = '33333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OUTSIDER = '44444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const NEWCOMER = '55555555-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OTHER = '66666666-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
// Accounts for the email-invite rules (two accounts can share an email: Google ids are what's unique).
const ANA = '77777777-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const ANA_TWIN = '88888888-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const ANA_CAPS = '99999999-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const SOMEONE = 'aaaaaaaa-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EMAILS: Record<string, string> = {
  [ANA]: 'ana@example.com',
  [ANA_TWIN]: 'ana@example.com',
  [ANA_CAPS]: 'Ana@EXAMPLE.com',
  [SOMEONE]: 'someone@else.org',
};
const ALL_USERS = [OWNER, EDITOR, VIEWER, OUTSIDER, NEWCOMER, OTHER, ANA, ANA_TWIN, ANA_CAPS, SOMEONE];
const USERS: Record<string, string> = { owner: OWNER, editor: EDITOR, viewer: VIEWER, outsider: OUTSIDER };
const DAY = 86_400_000;

describe('Members and invites API (feature)', () => {
  const db = appDb();
  let app: INestApplication;
  let baseUrl: string;
  let members: MembersService;
  let refreshTokens: RefreshTokenService;
  let tokens: Record<string, string>;
  const sendInvite = jest.spyOn(LoggingInviteMailer.prototype, 'sendInvite');

  beforeAll(async () => {
    const moduleRef = await appTestingModule(db, [MembersModule], { APP_INVITE_BASE_URL: 'https://holid.example/' }).compile();
    tokens = await accessTokens(moduleRef, ALL_USERS);
    refreshTokens = moduleRef.get(RefreshTokenService);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
    members = moduleRef.get(MembersService);
  });

  afterAll(async () => {
    await app?.close();
    sendInvite.mockRestore();
  });

  beforeEach(() => {
    db.clear();
    for (const id of ALL_USERS) seedUser(db, id, EMAILS[id] ? { email: EMAILS[id] } : {});
    db.afterRead = undefined;
    db.beforeWrite = undefined;
    sendInvite.mockClear();
  });

  /** Calls the API signed in as `user` (a real access token), or anonymously with null. */
  const call = (method: string, path: string, user: string | null, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** A trip owned by `owner`; other members join one minute apart, in order. */
  function seedTrip(
    owner = OWNER,
    others: [string, TripRole][] = [[EDITOR, 'editor'], [VIEWER, 'viewer']],
    fields: Partial<Trip> = {},
  ): string {
    const trip = db.seed(Trip, {
      provider: null,
      chatId: null,
      ownerUserId: owner,
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      ...fields,
    });
    [[owner, 'owner'] as [string, TripRole], ...others].forEach(([userId, role], i) =>
      db.seed(TripMember, { tripId: trip.id, userId, role, joinedAt: new Date(Date.UTC(2026, 9, 1, 10, i)) }),
    );
    return trip.id;
  }

  /** An invite with a known token. */
  function seedInvite(tripId: string, fields: Partial<TripInvite> = {}): string {
    const token = randomBytes(32).toString('base64url');
    db.seed(TripInvite, {
      tripId,
      email: null,
      tokenHash: hashToken(token),
      role: 'editor',
      createdBy: OWNER,
      expiresAt: new Date(Date.now() + 7 * DAY),
      ...fields,
    });
    return token;
  }

  const roleOf = (tripId: string, userId: string) => db.all(TripMember, { tripId, userId })[0]?.role;

  describe('authentication', () => {
    it.each([
      ['GET', '/trips/x/members'],
      ['PATCH', '/trips/x/members/y'],
      ['DELETE', '/trips/x/members/me'],
      ['POST', '/trips/x/invites'],
      ['GET', '/invites/abc'],
      ['POST', '/invites/abc/accept'],
    ])('%s %s without a user is 401', async (method, path) => {
      const res = await call(method, path, null, method === 'PATCH' ? { role: 'viewer' } : undefined);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED', message: 'Missing access token' });
    });
  });

  describe('GET /trips/:id/members', () => {
    it.each([
      ['owner', 200],
      ['editor', 200],
      ['viewer', 200],
      ['outsider', 404],
    ])('as %s is %i', async (who, status) => {
      const id = seedTrip();

      const res = await call('GET', `/trips/${id}/members`, USERS[who]);

      expect(res.status).toBe(status);
      if (status === 404) expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Trip not found' });
    });

    it('lists every member, owner first then by join date, with profiles', async () => {
      const id = seedTrip(OWNER, [[EDITOR, 'editor'], [VIEWER, 'viewer'], [NEWCOMER, 'viewer']]);
      // The owner may have joined last (after a transfer); they still come first.
      db.manager(null).update(TripMember, { tripId: id, userId: OWNER }, { joinedAt: new Date(Date.UTC(2026, 9, 9)) });

      const res = await call('GET', `/trips/${id}/members`, EDITOR);

      const body = (await res.json()) as { members: MemberDto[] };
      expect(body.members.map((m) => [m.userId, m.role])).toEqual([
        [OWNER, 'owner'],
        [EDITOR, 'editor'],
        [VIEWER, 'viewer'],
        [NEWCOMER, 'viewer'],
      ]);
      expect(body.members[0]).toEqual({
        userId: OWNER,
        displayName: 'Traveler 1111',
        avatarUrl: null,
        role: 'owner',
        joinedAt: '2026-10-09T00:00:00.000Z',
      });
    });
  });

  describe('PATCH /trips/:id/members/:userId', () => {
    it.each([
      ['owner', 200, undefined],
      ['editor', 403, 'FORBIDDEN'],
      ['viewer', 403, 'FORBIDDEN'],
      ['outsider', 404, 'NOT_FOUND'],
    ])('as %s is %i', async (who, status, code) => {
      const id = seedTrip();

      const res = await call('PATCH', `/trips/${id}/members/${VIEWER}`, USERS[who], { role: 'editor' });

      expect(res.status).toBe(status);
      const body = await res.json();
      if (code) {
        expect(body).toEqual({ code, message: expect.any(String) });
        expect(roleOf(id, VIEWER)).toBe('viewer');
      } else {
        expect(body).toEqual({
          userId: VIEWER,
          displayName: 'Traveler 3333',
          avatarUrl: null,
          role: 'editor',
          joinedAt: expect.any(String),
        });
        expect(roleOf(id, VIEWER)).toBe('editor');
      }
    });

    it('transfers ownership: the target becomes owner, the old owner editor, and the trip owner changes', async () => {
      const id = seedTrip();

      const res = await call('PATCH', `/trips/${id}/members/${VIEWER}`, OWNER, { role: 'owner' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ userId: VIEWER, role: 'owner' });
      expect(roleOf(id, OWNER)).toBe('editor');
      expect(roleOf(id, VIEWER)).toBe('owner');
      expect(db.all(Trip, { id })[0].ownerUserId).toBe(VIEWER);
      const trip = (await (await call('GET', `/trips/${id}`, OWNER)).json()) as AppTripDto;
      expect(trip.myRole).toBe('editor');
      // The old owner can no longer manage members.
      expect((await call('PATCH', `/trips/${id}/members/${EDITOR}`, OWNER, { role: 'viewer' })).status).toBe(403);
    });

    it('rolls the whole transfer back when a step fails', async () => {
      const id = seedTrip();
      db.beforeWrite = (operation, entity) => {
        if (operation === 'update' && entity === Trip) throw new Error('db down');
      };

      const res = await call('PATCH', `/trips/${id}/members/${EDITOR}`, OWNER, { role: 'owner' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ code: 'INTERNAL', message: 'Something went wrong' });
      expect([roleOf(id, OWNER), roleOf(id, EDITOR)]).toEqual(['owner', 'editor']);
      expect(db.all(Trip, { id })[0].ownerUserId).toBe(OWNER);
    });

    it("doesn't let the owner change their own role except to owner (a no-op)", async () => {
      const id = seedTrip();

      const demote = await call('PATCH', `/trips/${id}/members/${OWNER}`, OWNER, { role: 'editor' });
      const keep = await call('PATCH', `/trips/${id}/members/${OWNER}`, OWNER, { role: 'owner' });

      expect(demote.status).toBe(409);
      expect((await demote.json()).code).toBe('CONFLICT');
      expect(keep.status).toBe(200);
      expect(roleOf(id, OWNER)).toBe('owner');
    });

    it('is 404 for a non-member or malformed user id, and 400 for an unknown role', async () => {
      const id = seedTrip();

      const outsider = await call('PATCH', `/trips/${id}/members/${OUTSIDER}`, OWNER, { role: 'viewer' });
      const transferToOutsider = await call('PATCH', `/trips/${id}/members/${OUTSIDER}`, OWNER, { role: 'owner' });
      const malformed = await call('PATCH', `/trips/${id}/members/me`, OWNER, { role: 'viewer' });
      const badRole = await call('PATCH', `/trips/${id}/members/${VIEWER}`, OWNER, { role: 'admin' });

      expect(await outsider.json()).toEqual({ code: 'NOT_FOUND', message: 'Member not found' });
      expect(transferToOutsider.status).toBe(404);
      expect(roleOf(id, OWNER)).toBe('owner');
      expect(malformed.status).toBe(404);
      expect(badRole.status).toBe(400);
      expect(await badRole.json()).toMatchObject({ code: 'VALIDATION', fields: { role: expect.any(String) } });
    });
  });

  describe('DELETE /trips/:id/members/:userId', () => {
    it.each([
      ['owner', 204],
      ['editor', 403],
      ['viewer', 403],
      ['outsider', 404],
    ])('removing another member as %s is %i', async (who, status) => {
      const id = seedTrip(OWNER, [[EDITOR, 'editor'], [VIEWER, 'viewer'], [NEWCOMER, 'viewer']]);

      const res = await call('DELETE', `/trips/${id}/members/${NEWCOMER}`, USERS[who]);

      expect(res.status).toBe(status);
      expect(roleOf(id, NEWCOMER)).toBe(status === 204 ? undefined : 'viewer');
    });

    it.each([
      ['editor', 204],
      ['viewer', 204],
      ['owner', 409],
      ['outsider', 404],
    ])('leaving with "me" as %s is %i', async (who, status) => {
      const id = seedTrip();

      const res = await call('DELETE', `/trips/${id}/members/me`, USERS[who]);

      expect(res.status).toBe(status);
      if (status === 204) expect(roleOf(id, USERS[who])).toBeUndefined();
      if (status === 409) {
        expect(await res.json()).toEqual({
          code: 'CONFLICT',
          message: "The owner can't leave the trip; transfer ownership first",
        });
        expect(roleOf(id, OWNER)).toBe('owner');
      }
    });

    it("doesn't let the owner remove themselves by id, even as the last member", async () => {
      const id = seedTrip(OWNER, []);

      const res = await call('DELETE', `/trips/${id}/members/${OWNER}`, OWNER);

      expect(res.status).toBe(409);
      expect(roleOf(id, OWNER)).toBe('owner');
    });

    it('lets a member leave by their own id', async () => {
      const id = seedTrip();

      expect((await call('DELETE', `/trips/${id}/members/${EDITOR}`, EDITOR)).status).toBe(204);
      expect(roleOf(id, EDITOR)).toBeUndefined();
    });

    describe('revoking the departing member\'s invites', () => {
      const pendingOf = (token: string) => db.all(TripInvite, { tokenHash: hashToken(token) })[0].revokedAt === null;

      it.each([
        ['leaves', EDITOR, 'me'],
        ['is removed', OWNER, EDITOR],
      ])('revokes their unused invites for the trip when the member %s', async (_label, caller, target) => {
        const id = seedTrip();
        const other = seedTrip(OTHER, [[EDITOR, 'editor']]);
        const link = seedInvite(id, { createdBy: EDITOR });
        const email = seedInvite(id, { createdBy: EDITOR, email: 'ana@example.com' });
        const used = seedInvite(id, { createdBy: EDITOR, email: 'bob@example.com', acceptedBy: NEWCOMER, acceptedAt: new Date() });
        const ownersInvite = seedInvite(id, { createdBy: OWNER });
        const otherTrip = seedInvite(other, { createdBy: EDITOR });

        const res = await call('DELETE', `/trips/${id}/members/${target}`, caller);

        expect(res.status).toBe(204);
        expect([pendingOf(link), pendingOf(email)]).toEqual([false, false]);
        expect([pendingOf(used), pendingOf(ownersInvite), pendingOf(otherTrip)]).toEqual([true, true, true]);
        expect((await call('POST', `/invites/${link}/accept`, NEWCOMER)).status).toBe(404);
        expect((await call('POST', `/invites/${ownersInvite}/accept`, NEWCOMER)).status).toBe(200);
      });

      it('keeps the membership and the invites when the revocation fails', async () => {
        const id = seedTrip();
        const link = seedInvite(id, { createdBy: EDITOR });
        db.beforeWrite = (operation, entity) => {
          if (operation === 'update' && entity === TripInvite) throw new Error('db down');
        };

        expect((await call('DELETE', `/trips/${id}/members/me`, EDITOR)).status).toBe(500);
        expect(roleOf(id, EDITOR)).toBe('editor');
        expect(pendingOf(link)).toBe(true);
      });

      it('revokes nothing on an ownership transfer', async () => {
        const id = seedTrip();
        const ownersInvite = seedInvite(id, { createdBy: OWNER });
        const editorsInvite = seedInvite(id, { createdBy: EDITOR });

        expect((await call('PATCH', `/trips/${id}/members/${EDITOR}`, OWNER, { role: 'owner' })).status).toBe(200);
        expect([pendingOf(ownersInvite), pendingOf(editorsInvite)]).toEqual([true, true]);
      });
    });

    it('is 404 for a member that is not on the trip', async () => {
      const id = seedTrip();

      const res = await call('DELETE', `/trips/${id}/members/${OUTSIDER}`, OWNER);

      expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Member not found' });
    });
  });

  describe('POST /trips/:id/invites', () => {
    it.each([
      ['owner', 201],
      ['editor', 201],
      ['viewer', 403],
      ['outsider', 404],
    ])('as %s is %i', async (who, status) => {
      const id = seedTrip();

      const res = await call('POST', `/trips/${id}/invites`, USERS[who], {});

      expect(res.status).toBe(status);
      expect(db.all(TripInvite)).toHaveLength(status === 201 ? 1 : 0);
    });

    it('creates a 7-day editor link invite, storing only the token hash', async () => {
      const id = seedTrip();
      const before = Date.now();

      const res = await call('POST', `/trips/${id}/invites`, EDITOR, {});

      const invite = (await res.json()) as InviteDto;
      const token = invite.url.split('/').pop()!;
      expect(invite).toEqual({
        id: expect.any(String),
        url: `https://holid.example/invite/${token}`,
        deepLink: `holidai://invite/${token}`,
        email: null,
        role: 'editor',
        expiresAt: expect.any(String),
      });
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Date.parse(invite.expiresAt) - before).toBeGreaterThanOrEqual(7 * DAY - 1000);
      expect(Date.parse(invite.expiresAt) - before).toBeLessThanOrEqual(7 * DAY + 5000);
      const [stored] = db.all(TripInvite);
      expect(stored).toMatchObject({ tripId: id, createdBy: EDITOR, tokenHash: hashToken(token), role: 'editor' });
      expect(JSON.stringify(stored)).not.toContain(token);
      expect(sendInvite).not.toHaveBeenCalled();
    });

    it('emails an email invite, with the role asked for', async () => {
      const id = seedTrip();

      const res = await call('POST', `/trips/${id}/invites`, OWNER, { email: ' Ana@Example.com ', role: 'viewer' });

      const invite = (await res.json()) as InviteDto;
      expect(invite).toMatchObject({ email: 'ana@example.com', role: 'viewer' });
      expect(sendInvite).toHaveBeenCalledWith(
        expect.objectContaining({
          inviteId: invite.id,
          email: 'ana@example.com',
          role: 'viewer',
          destination: 'Lisbon',
          invitedBy: 'Traveler 1111',
          url: invite.url,
          deepLink: invite.deepLink,
        }),
      );
    });

    it('never logs the plain token at info level (or above)', async () => {
      const id = seedTrip();
      const spies = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );

      const invite = (await (await call('POST', `/trips/${id}/invites`, OWNER, { email: 'ana@example.com' })).json()) as InviteDto;

      const token = invite.url.split('/').pop()!;
      const [log, warn, error, debug] = spies.map((spy) => JSON.stringify(spy.mock.calls));
      expect(log).toContain(invite.id);
      expect(log + warn + error).not.toContain(token);
      expect(debug).toContain(token);
      spies.forEach((spy) => spy.mockRestore());
    });

    it('still returns the invite when sending the email fails', async () => {
      const id = seedTrip();
      sendInvite.mockRejectedValueOnce(new Error('smtp down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      const res = await call('POST', `/trips/${id}/invites`, OWNER, { email: 'ana@example.com' });

      expect(res.status).toBe(201);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it.each([
      ['an editor', EDITOR],
      ['the owner', OWNER],
    ])('rejects %s inviting as owner (validation)', async (_label, user) => {
      const id = seedTrip();

      const res = await call('POST', `/trips/${id}/invites`, user, { role: 'owner' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: 'VALIDATION',
        message: 'Some fields are invalid',
        fields: { role: 'role must be editor or viewer' },
      });
      expect(db.all(TripInvite)).toEqual([]);
    });

    it('rejects a malformed email and unknown fields', async () => {
      const id = seedTrip();

      const res = await call('POST', `/trips/${id}/invites`, OWNER, { email: 'ana', expiresAt: '2030-01-01' });

      expect(res.status).toBe(400);
      expect(Object.keys((await res.json()).fields).sort()).toEqual(['email', 'expiresAt']);
    });
  });

  describe('GET /invites/:token', () => {
    it('previews a usable invite', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { createdBy: EDITOR, role: 'viewer' });

      const res = await call('GET', `/invites/${token}`, OUTSIDER);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        destination: 'Lisbon',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        invitedBy: 'Traveler 2222',
        role: 'viewer',
        expiresAt: expect.any(String),
      });
    });

    it.each<[string, Partial<TripInvite>]>([
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['revoked', { revokedAt: new Date() }],
      ['a used email invite', { email: 'ana@example.com', acceptedBy: OTHER, acceptedAt: new Date() }],
    ])('is 404 when %s', async (_label, fields) => {
      const token = seedInvite(seedTrip(), fields);

      const res = await call('GET', `/invites/${token}`, OUTSIDER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ code: 'NOT_FOUND', message: 'Invite not found' });
    });

    it('is 404 for an unknown or malformed token', async () => {
      seedInvite(seedTrip());

      expect((await call('GET', `/invites/${randomBytes(32).toString('base64url')}`, OUTSIDER)).status).toBe(404);
      expect((await call('GET', '/invites/short', OUTSIDER)).status).toBe(404);
    });
  });

  describe('POST /invites/:token/accept', () => {
    it("joins with the invite's role and returns the trip", async () => {
      const id = seedTrip();
      const token = seedInvite(id, { role: 'viewer' });

      const res = await call('POST', `/invites/${token}/accept`, NEWCOMER);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, myRole: 'viewer', memberCount: 4 });
      expect(roleOf(id, NEWCOMER)).toBe('viewer');
    });

    it.each([
      ['relaxer', 'pt-BR', 'Viajante tranquilo'],
      // A row saved before persona keys holds the English label.
      ['Easygoing Wanderer', 'es-419', 'Viajero relajado'],
      ['foodie', 'fr', 'Taste Hunter'],
    ])('returns the persona stored as %p in Accept-Language %p', async (persona, language, label) => {
      const travelerProfile = { questionSetVersion: 1, answers: {}, persona };
      const id = seedTrip(OWNER, [], { travelerProfile });
      const token = seedInvite(id);

      const res = await fetch(`${baseUrl}/invites/${token}/accept`, {
        method: 'POST',
        headers: { authorization: `Bearer ${tokens[NEWCOMER]}`, 'accept-language': language },
      });

      expect(res.status).toBe(200);
      expect(((await res.json()) as AppTripDto).travelerProfile).toEqual({ ...travelerProfile, persona: label });
    });

    it('lets several users use a link invite until it expires', async () => {
      const id = seedTrip();
      const token = seedInvite(id);

      expect((await call('POST', `/invites/${token}/accept`, NEWCOMER)).status).toBe(200);
      expect((await call('POST', `/invites/${token}/accept`, OUTSIDER)).status).toBe(200);
      expect([roleOf(id, NEWCOMER), roleOf(id, OUTSIDER)]).toEqual(['editor', 'editor']);
      expect(db.all(TripInvite)[0]).toMatchObject({ acceptedAt: null, revokedAt: null });
    });

    it('uses an email invite once', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { email: 'ana@example.com' });

      const first = await call('POST', `/invites/${token}/accept`, ANA);
      // Even another account with the same email can't reuse it.
      const second = await call('POST', `/invites/${token}/accept`, ANA_TWIN);

      expect(first.status).toBe(200);
      expect(second.status).toBe(404);
      expect(roleOf(id, ANA_TWIN)).toBeUndefined();
      expect(db.all(TripInvite)[0]).toMatchObject({ acceptedBy: ANA, acceptedAt: expect.any(Date) });
    });

    it('refuses an email invite to another account without using it up', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { email: 'ana@example.com', role: 'viewer' });

      const wrong = await call('POST', `/invites/${token}/accept`, OUTSIDER);

      expect(wrong.status).toBe(403);
      expect(await wrong.json()).toEqual({ code: 'FORBIDDEN', message: 'This invite is for a different account' });
      expect(roleOf(id, OUTSIDER)).toBeUndefined();
      expect(db.all(TripInvite)[0]).toMatchObject({ acceptedBy: null, acceptedAt: null, revokedAt: null });
      // The preview stays open to anyone, and the right account can still use the invite.
      expect((await call('GET', `/invites/${token}`, OUTSIDER)).status).toBe(200);
      const right = await call('POST', `/invites/${token}/accept`, ANA);
      expect(right.status).toBe(200);
      expect(roleOf(id, ANA)).toBe('viewer');
    });

    it('matches the email case-insensitively', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { email: 'ana@example.com' });

      const res = await call('POST', `/invites/${token}/accept`, ANA_CAPS);

      expect(res.status).toBe(200);
      expect(db.all(TripInvite)[0].acceptedBy).toBe(ANA_CAPS);
    });

    it('lets anyone use a link invite, whatever their email', async () => {
      const id = seedTrip();
      const token = seedInvite(id);

      expect((await call('POST', `/invites/${token}/accept`, SOMEONE)).status).toBe(200);
    });

    it('lets only one of two concurrent accepts use an email invite', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { email: 'ana@example.com' });
      // Both requests read the invite as unused before either claims it. (Two accounts with the
      // invited email, so both pass the email check and only the race decides.)
      const bothRead = barrier(2);
      db.afterRead = async (entity) => {
        if (entity === TripInvite) await bothRead();
      };

      const results = await Promise.all([
        call('POST', `/invites/${token}/accept`, ANA),
        call('POST', `/invites/${token}/accept`, ANA_TWIN),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
      const joined = [ANA, ANA_TWIN].filter((u) => roleOf(id, u));
      expect(joined).toHaveLength(1);
      expect(db.all(TripInvite)[0].acceptedBy).toBe(joined[0]);
    });

    it('gives the same user 200 twice for concurrent accepts of a link invite, with one membership', async () => {
      const id = seedTrip();
      const token = seedInvite(id);
      const bothRead = barrier(2);
      db.afterRead = async (entity) => {
        if (entity === TripInvite) await bothRead();
      };

      const results = await Promise.all([
        call('POST', `/invites/${token}/accept`, NEWCOMER),
        call('POST', `/invites/${token}/accept`, NEWCOMER),
      ]);

      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(db.all(TripMember, { tripId: id, userId: NEWCOMER })).toHaveLength(1);
    });

    it('returns 200 to an existing member with no duplicate, no role change and the email invite unused', async () => {
      const id = seedTrip();
      const token = seedInvite(id, { email: 'ana@example.com', role: 'editor' });

      const res = await call('POST', `/invites/${token}/accept`, VIEWER);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id, myRole: 'viewer', memberCount: 3 });
      expect(db.all(TripMember, { tripId: id, userId: VIEWER })).toHaveLength(1);
      expect(db.all(TripInvite)[0].acceptedAt).toBeNull();
    });

    it.each<[string, Partial<TripInvite>]>([
      ['expired', { expiresAt: new Date(Date.now() - 1000) }],
      ['revoked', { revokedAt: new Date() }],
    ])('is 404 when the invite is %s', async (_label, fields) => {
      const id = seedTrip();
      const token = seedInvite(id, fields);

      const res = await call('POST', `/invites/${token}/accept`, NEWCOMER);

      expect(res.status).toBe(404);
      expect(roleOf(id, NEWCOMER)).toBeUndefined();
    });

    it('is 404 once the trip is deleted (its invites go with it)', async () => {
      const id = seedTrip();
      const token = seedInvite(id);
      expect((await call('DELETE', `/trips/${id}`, OWNER)).status).toBe(204);

      expect((await call('POST', `/invites/${token}/accept`, NEWCOMER)).status).toBe(404);
      expect(db.all(TripInvite)).toEqual([]);
    });
  });

  describe('MembersService.handleUserDeleted', () => {
    it('deletes trips the user is the only member of, with their invites', async () => {
      const solo = seedTrip(OWNER, []);
      seedInvite(solo);

      await expect(members.handleUserDeleted(OWNER)).resolves.toEqual({ deletedTripIds: [solo], transferred: [] });
      expect(db.all(Trip)).toEqual([]);
      expect(db.all(TripInvite)).toEqual([]);
    });

    it('passes a shared trip to the longest-standing editor, even if a viewer joined earlier', async () => {
      const id = seedTrip(OWNER, [[VIEWER, 'viewer'], [NEWCOMER, 'editor'], [EDITOR, 'editor']]);

      const result = await members.handleUserDeleted(OWNER);

      expect(result.transferred).toEqual([{ tripId: id, newOwnerId: NEWCOMER }]);
      expect([roleOf(id, NEWCOMER), roleOf(id, EDITOR), roleOf(id, VIEWER), roleOf(id, OWNER)]).toEqual([
        'owner',
        'editor',
        'viewer',
        undefined,
      ]);
      expect(db.all(Trip, { id })[0].ownerUserId).toBe(NEWCOMER);
    });

    it('falls back to the longest-standing member when there is no editor', async () => {
      const id = seedTrip(OWNER, [[VIEWER, 'viewer'], [NEWCOMER, 'viewer']]);

      await members.handleUserDeleted(OWNER);

      expect(roleOf(id, VIEWER)).toBe('owner');
      expect(db.all(Trip, { id })[0].ownerUserId).toBe(VIEWER);
    });

    it("removes their memberships of other people's trips and revokes their pending invites only", async () => {
      const theirs = seedTrip(OTHER, [[EDITOR, 'editor']]);
      const pending = seedInvite(theirs, { createdBy: EDITOR });
      const used = seedInvite(theirs, { createdBy: EDITOR, email: 'a@example.com', acceptedBy: NEWCOMER, acceptedAt: new Date() });
      const someoneElses = seedInvite(theirs, { createdBy: OTHER });
      const bot = db.seed(Trip, { provider: 'telegram', chatId: '1', destination: 'Rome', startDate: '2026-11-01', endDate: '2026-11-02' });

      await members.handleUserDeleted(EDITOR);

      expect(roleOf(theirs, EDITOR)).toBeUndefined();
      expect(roleOf(theirs, OTHER)).toBe('owner');
      const byHash = (token: string) => db.all(TripInvite, { tokenHash: hashToken(token) })[0];
      expect(byHash(pending).revokedAt).toEqual(expect.any(Date));
      expect(byHash(used).revokedAt).toBeNull();
      expect(byHash(someoneElses).revokedAt).toBeNull();
      expect(db.all(Trip, { id: bot.id })).toHaveLength(1);
      expect((await call('POST', `/invites/${pending}/accept`, NEWCOMER)).status).toBe(404);
    });

    it('changes nothing when a step fails', async () => {
      const solo = seedTrip(OWNER, []);
      const shared = seedTrip(OWNER, [[EDITOR, 'editor']]);
      db.beforeWrite = (operation, entity) => {
        if (operation === 'update' && entity === TripInvite) throw new Error('db down');
      };

      await expect(members.handleUserDeleted(OWNER)).rejects.toThrow('db down');

      expect(db.all(Trip).map((t) => t.id).sort()).toEqual([solo, shared].sort());
      expect([roleOf(shared, OWNER), roleOf(shared, EDITOR), roleOf(solo, OWNER)]).toEqual(['owner', 'editor', 'owner']);
      expect(db.all(Trip, { id: shared })[0].ownerUserId).toBe(OWNER);
    });

    it('runs on DELETE /app/v1/me: sole trip deleted, shared trip handed over, tokens revoked', async () => {
      const solo = seedTrip(OWNER, []);
      const shared = seedTrip(OWNER, [[VIEWER, 'viewer'], [EDITOR, 'editor']]);
      const theirs = seedTrip(OTHER, [[OWNER, 'editor']]);
      const invite = seedInvite(shared, { createdBy: OWNER });
      await refreshTokens.issue(OWNER);
      await refreshTokens.issue(OWNER);

      const res = await call('DELETE', '/me', OWNER);

      expect(res.status).toBe(204);
      expect(db.all(Trip, { id: solo })).toEqual([]);
      expect(db.all(Trip, { id: shared })[0].ownerUserId).toBe(EDITOR);
      expect([roleOf(shared, EDITOR), roleOf(shared, VIEWER), roleOf(shared, OWNER)]).toEqual(['owner', 'viewer', undefined]);
      expect(roleOf(theirs, OWNER)).toBeUndefined();
      expect(db.all(TripInvite, { tokenHash: hashToken(invite) })[0].revokedAt).toEqual(expect.any(Date));
      expect(db.all(RefreshToken, { userId: OWNER }).map((t) => t.revokedAt)).toEqual([expect.any(Date), expect.any(Date)]);
      expect(db.all(User, { id: OWNER })[0].deletedAt).toEqual(expect.any(Date));
      // The access token stops working with the account.
      expect((await call('GET', '/trips', OWNER)).status).toBe(401);
      expect((await call('GET', `/trips/${shared}`, EDITOR)).status).toBe(200);
    });

    it('leaves the account and its trips intact when the trip cleanup fails', async () => {
      const solo = seedTrip(OWNER, []);
      db.beforeWrite = (operation, entity) => {
        if (operation === 'update' && entity === TripInvite) throw new Error('db down');
      };

      const res = await call('DELETE', '/me', OWNER);

      expect(res.status).toBe(500);
      expect(db.all(Trip, { id: solo })).toHaveLength(1);
      expect(db.all(User, { id: OWNER })[0].deletedAt).toBeNull();
      db.beforeWrite = undefined;
      expect((await call('GET', '/trips', OWNER)).status).toBe(200);
    });

    it('does nothing for a user with no trips', async () => {
      seedTrip();

      await expect(members.handleUserDeleted(OUTSIDER)).resolves.toEqual({ deletedTripIds: [], transferred: [] });
      expect(db.all(TripMember)).toHaveLength(3);
    });
  });
});
