import { randomBytes } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { TripRole } from '../app-trips/app-trips.types.js';
import { appDb } from '../testing/app-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';
import { TripInvite } from './trip-invite.entity.js';
import { TripRemoval } from './trip-removal.entity.js';
import { MembersModule } from './members.module.js';
import { hashToken } from './invites.service.js';
import type { InviteSummaryDto } from './members.types.js';
import { assertDevLoginAllowed, isDevLoginEnabled } from '../auth/dev-login.js';

// QA gap specs for invite management and removed members (qa/email-test-plan.md, cases S-xx).
// Bugs are tagged with their BUGS.md id; `it.failing` marks a confirmed bug.

const OWNER = 'c1111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = 'c2222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const NEWCOMER = 'c5555555-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OUTSIDER = 'c4444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS = [OWNER, EDITOR, NEWCOMER, OUTSIDER];
const NEWCOMER_EMAIL = 'newcomer@example.com';
const MIN = 60_000;
const DAY = 86_400_000;

describe('Invite management (QA feature)', () => {
  const db = appDb();
  let app: INestApplication;
  let baseUrl: string;
  let tokens: Record<string, string>;

  beforeAll(async () => {
    const moduleRef = await appTestingModule(db, [MembersModule], { APP_INVITE_BASE_URL: 'https://holid.example/' }).compile();
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
    for (const id of USERS) seedUser(db, id, id === NEWCOMER ? { email: NEWCOMER_EMAIL } : {});
    db.afterRead = undefined;
    db.beforeWrite = undefined;
  });

  const call = (method: string, path: string, user: string | null) =>
    fetch(`${baseUrl}${path}`, { method, headers: user ? { authorization: `Bearer ${tokens[user]}` } : {} });

  function seedTrip(): string {
    const trip = db.seed(Trip, {
      provider: null,
      chatId: null,
      ownerUserId: OWNER,
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
    });
    ([[OWNER, 'owner'], [EDITOR, 'editor']] as [string, TripRole][]).forEach(([userId, role], i) =>
      db.seed(TripMember, { tripId: trip.id, userId, role, joinedAt: new Date(Date.UTC(2026, 9, 1, 10, i)) }),
    );
    return trip.id;
  }

  /** An invite with a known token; returns the token and the row id. */
  function seedInvite(tripId: string, fields: Partial<TripInvite> = {}): { token: string; id: string } {
    const token = randomBytes(32).toString('base64url');
    const row = db.seed(TripInvite, {
      tripId,
      email: null,
      tokenHash: hashToken(token),
      role: 'editor',
      createdBy: OWNER,
      expiresAt: new Date(Date.now() + 7 * DAY),
      ...fields,
    });
    return { token, id: row.id };
  }

  const list = async (tripId: string, user = OWNER) => {
    const res = await call('GET', `/trips/${tripId}/invites`, user);
    expect(res.status).toBe(200);
    return ((await res.json()) as { invites: InviteSummaryDto[] }).invites;
  };

  const isMember = (tripId: string, userId: string) => db.all(TripMember, { tripId, userId }).length > 0;

  describe('GET /trips/:id/invites', () => {
    // S-05: the token is only shown once, at create.
    it('never exposes url, deepLink, the token or its hash', async () => {
      const id = seedTrip();
      const { token } = seedInvite(id, { email: 'ana@example.com' });
      seedInvite(id);

      const res = await call('GET', `/trips/${id}/invites`, OWNER);
      const raw = await res.text();
      const { invites } = JSON.parse(raw) as { invites: InviteSummaryDto[] };

      expect(invites).toHaveLength(2);
      for (const invite of invites) {
        expect(Object.keys(invite).sort()).toEqual(['createdAt', 'createdBy', 'email', 'expiresAt', 'id', 'role']);
        expect(Object.keys(invite.createdBy).sort()).toEqual(['avatarUrl', 'displayName', 'role', 'userId']);
      }
      expect(raw).not.toContain(token);
      expect(raw).not.toContain(hashToken(token));
      expect(raw).not.toMatch(/invite\/|holidai:|tokenHash/);
    });

    // S-04: only active invites; link invites stay listed after being used.
    it('lists only active invites, keeping a used link invite', async () => {
      const id = seedTrip();
      const activeLink = seedInvite(id);
      const activeEmail = seedInvite(id, { email: 'pending@example.com' });
      seedInvite(id, { email: 'used@example.com', acceptedAt: new Date(), acceptedBy: OUTSIDER });
      seedInvite(id, { revokedAt: new Date() });
      seedInvite(id, { expiresAt: new Date(Date.now() - 1) });
      const almostExpired = seedInvite(id, { expiresAt: new Date(Date.now() + MIN) });
      expect((await call('POST', `/invites/${activeLink.token}/accept`, NEWCOMER)).status).toBe(200);

      expect((await list(id)).map((i) => i.id).sort()).toEqual([activeLink.id, activeEmail.id, almostExpired.id].sort());
    });

    // S-06
    it('orders invites created at the same instant deterministically', async () => {
      const id = seedTrip();
      const at = new Date('2026-10-01T10:00:00Z');
      const ids = [0, 1, 2, 3].map(() => seedInvite(id, { createdAt: at }).id);

      const first = (await list(id)).map((i) => i.id);
      const second = (await list(id)).map((i) => i.id);

      expect(first).toEqual(second);
      expect([...first].sort()).toEqual([...ids].sort());
    });
  });

  describe('revoke racing an accept (S-12)', () => {
    /** Holds the first read of trip_invites (the accept's) until `release()`. */
    function holdFirstInviteRead() {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      const reached = new Promise<void>((resolve) => {
        db.afterRead = async (entity) => {
          if (entity !== TripInvite || held) return;
          held = true;
          resolve();
          await gate;
        };
      });
      return { reached, release };
    }

    // BUG-022 (fixed): a link invite was joined without a conditional write, so an accept that read it just
    // before a revoke still added the member after the owner got 204 for the revoke.
    it('never lets someone join through a link invite whose revoke already succeeded', async () => {
      const id = seedTrip();
      const link = seedInvite(id);
      const hold = holdFirstInviteRead();

      const accept = call('POST', `/invites/${link.token}/accept`, NEWCOMER);
      await hold.reached;
      const revoke = await call('DELETE', `/trips/${id}/invites/${link.id}`, OWNER);
      hold.release();
      const accepted = await accept;

      expect(revoke.status).toBe(204);
      expect(accepted.status).toBe(404);
      expect(isMember(id, NEWCOMER)).toBe(false);
    });

    it('never lets someone use an email invite whose revoke already succeeded', async () => {
      const id = seedTrip();
      const invite = seedInvite(id, { email: NEWCOMER_EMAIL });
      const hold = holdFirstInviteRead();

      const accept = call('POST', `/invites/${invite.token}/accept`, NEWCOMER);
      await hold.reached;
      const revoke = await call('DELETE', `/trips/${id}/invites/${invite.id}`, OWNER);
      hold.release();
      const accepted = await accept;

      expect(revoke.status).toBe(204);
      expect(accepted.status).toBe(404);
      expect(isMember(id, NEWCOMER)).toBe(false);
    });
  });

  describe('removed members', () => {
    async function joinAndRemove() {
      const id = seedTrip();
      const link = seedInvite(id);
      expect((await call('POST', `/invites/${link.token}/accept`, NEWCOMER)).status).toBe(200);
      expect((await call('DELETE', `/trips/${id}/members/${NEWCOMER}`, OWNER)).status).toBe(204);
      return { id, link };
    }

    /** Moves the removal `ms` into the past, so invites can be dated between events. */
    const ageRemoval = (tripId: string, ms: number) =>
      db.manager(null).update(TripRemoval, { tripId, userId: NEWCOMER }, { removedAt: new Date(Date.now() - ms) });

    // S-23 / Q11
    it('can still preview a link invite after being removed', async () => {
      const { link } = await joinAndRemove();

      const res = await call('GET', `/invites/${link.token}`, NEWCOMER);

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ destination: 'Lisbon', role: 'editor' });
    });

    // S-21: the lifting email invite matches the address case-insensitively and trimmed.
    it('is brought back by an email invite to their address in another case', async () => {
      const { id } = await joinAndRemove();
      ageRemoval(id, 10 * MIN);
      const email = seedInvite(id, { email: '  NewComer@EXAMPLE.com ' });

      expect((await call('POST', `/invites/${email.token}/accept`, NEWCOMER)).status).toBe(200);
      expect(isMember(id, NEWCOMER)).toBe(true);
      expect(db.all(TripRemoval)).toEqual([]);
    });

    // S-22: a second removal is judged against its own time, not the first one.
    it('refuses, after a second removal, an email invite created between the two removals', async () => {
      const { id } = await joinAndRemove();
      ageRemoval(id, 60 * MIN);
      const between = seedInvite(id, { email: NEWCOMER_EMAIL, createdAt: new Date(Date.now() - 30 * MIN) });
      const comeback = seedInvite(id, { email: NEWCOMER_EMAIL, createdAt: new Date(Date.now() - 20 * MIN) });
      expect((await call('POST', `/invites/${comeback.token}/accept`, NEWCOMER)).status).toBe(200);
      expect((await call('DELETE', `/trips/${id}/members/${NEWCOMER}`, OWNER)).status).toBe(204);

      const res = await call('POST', `/invites/${between.token}/accept`, NEWCOMER);

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: 'FORBIDDEN', reason: 'REMOVED_FROM_TRIP', message: 'You were removed from this trip' });
      // Refused without using it up.
      expect(db.all(TripInvite, { id: between.id })[0].acceptedAt).toBeNull();
    });

    // Q9: the removal is per trip.
    it('only blocks the trip they were removed from', async () => {
      const { id } = await joinAndRemove();
      const other = seedTrip();
      const link = seedInvite(other);

      expect((await call('POST', `/invites/${link.token}/accept`, NEWCOMER)).status).toBe(200);
      expect(isMember(id, NEWCOMER)).toBe(false);
    });
  });
});

describe('dev login environment gate (QA)', () => {
  // Fails closed: only exact `development`/`test` enable it; any other spelling keeps it off.
  it.each(['Development', 'DEVELOPMENT', ' development', 'dev', 'Test', 'staging', 'Production', 'PRODUCTION', ''])(
    'keeps the dev login off for NODE_ENV=%p, without blocking startup',
    (nodeEnv) => {
      const env = { DEV_LOGIN_ENABLED: 'true', NODE_ENV: nodeEnv };
      expect(isDevLoginEnabled(env)).toBe(false);
      expect(() => assertDevLoginAllowed(env)).not.toThrow();
    },
  );
});
