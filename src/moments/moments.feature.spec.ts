import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { Moment } from './moment.entity.js';
import { MomentsService } from './moments.service.js';
import { UPLOAD_RATE_LIMIT } from './moments.types.js';
import type { CreatedMomentDto, MomentDto } from './moments.types.js';
import { RateWindow } from '../app-common/rate-window.js';
import { MemoryObjectStorage } from './testing/moments-testing.js';
import { bootMoments, EDITOR, OTHER, OWNER, VIEWER } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const PHOTO = { contentType: 'image/jpeg', byteSize: 2048, width: 1600, height: 1200, takenAt: '2026-10-08T14:30:00.000Z' };

describe('Moments API (feature)', () => {
  const storage = new MemoryObjectStorage();
  let h: Harness;
  const logged: string[] = [];

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
    // The upload limit is in memory per process: a fresh window per test.
    Object.assign(h.moduleRef.get(MomentsService), {
      uploads: new RateWindow(UPLOAD_RATE_LIMIT.max, UPLOAD_RATE_LIMIT.windowMs, 'Too many photo uploads. Please wait a little.'),
    });
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  /** Creates a moment and, unless `upload` is false, uploads it and completes it. */
  async function moment(user: string, tripId: string | null, fields: Record<string, unknown> = {}, upload = true): Promise<MomentDto> {
    const created = await h.json<CreatedMomentDto>('POST', '/moments', user, { ...PHOTO, tripId, ...fields });
    expect(created.status).toBe(201);
    if (!upload) return created.body.moment;
    const row = h.db.all(Moment, { id: created.body.moment.id })[0];
    storage.put(row.objectKey, row.byteSize);
    const completed = await h.json<MomentDto>('POST', `/moments/${created.body.moment.id}/complete`, user);
    expect(completed.status).toBe(200);
    return completed.body;
  }

  describe('the presign flow', () => {
    it('creates a pending moment with a presigned PUT, then completes it into a signed, listed photo', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [VIEWER, 'viewer']]);

      const created = await h.json<CreatedMomentDto>('POST', '/moments', VIEWER, { ...PHOTO, tripId: trip.id, lat: 38.7, lng: -9.14 }, { 'x-timezone': 'Europe/Lisbon' });

      expect(created.status).toBe(201);
      const { moment: pending, upload } = created.body;
      expect(pending).toMatchObject({ tripId: trip.id, status: 'pending', url: null, mine: true, takenOn: '2026-10-08', location: { lat: 38.7, lng: -9.14 } });
      expect(upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
      const row = h.db.all(Moment)[0];
      expect(row.objectKey).toBe(`moments/${VIEWER}/${pending.id}.jpg`);
      expect(upload.url).toContain(row.objectKey);
      expect(Date.parse(upload.expiresAt) - Date.now()).toBeGreaterThan(14 * 60_000);
      // Pending moments aren't listed.
      expect((await h.json<{ moments: MomentDto[] }>('GET', `/trips/${trip.id}/moments`, OWNER)).body.moments).toEqual([]);

      storage.put(row.objectKey, PHOTO.byteSize);
      const done = await h.json<MomentDto>('POST', `/moments/${pending.id}/complete`, VIEWER);

      expect(done.status).toBe(200);
      expect(done.body).toMatchObject({ status: 'ready', url: `https://bucket.test/${row.objectKey}?signed=get` });
      const listed = await h.json<{ moments: MomentDto[] }>('GET', `/trips/${trip.id}/moments`, OWNER);
      expect(listed.body.moments).toHaveLength(1);
      // Location is never shown to other members.
      expect(listed.body.moments[0]).toMatchObject({ id: pending.id, mine: false, location: null, author: { userId: VIEWER, displayName: 'Traveler 3333' } });
      // Completing again is idempotent.
      expect((await h.json('POST', `/moments/${pending.id}/complete`, VIEWER)).status).toBe(200);
    });

    it('lists newest first by when they were taken', async () => {
      const trip = h.seedTrip();
      await moment(OWNER, trip.id, { takenAt: '2026-10-01T10:00:00Z' });
      const newest = await moment(OWNER, trip.id, { takenAt: '2026-10-03T10:00:00Z' });
      await moment(OWNER, trip.id, { takenAt: '2026-10-02T10:00:00Z' });

      const listed = await h.json<{ moments: MomentDto[] }>('GET', `/trips/${trip.id}/moments`, OWNER);
      expect(listed.body.moments.map((m) => m.takenAt)).toEqual(['2026-10-03T10:00:00.000Z', '2026-10-02T10:00:00.000Z', '2026-10-01T10:00:00.000Z']);
      expect(listed.body.moments[0].id).toBe(newest.id);
    });

    it.each([
      ['a wrong type', { contentType: 'image/png' }],
      ['too big', { byteSize: 10 * 1024 * 1024 + 1 }],
      ['no size', { byteSize: 0 }],
      ['a bad takenAt', { takenAt: 'yesterday' }],
      ['a takenAt in the future', { takenAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
      ['lat without lng', { lat: 10 }],
      ['an out-of-range lat', { lat: 91, lng: 0 }],
      ['a malformed tripId', { tripId: 'nope' }],
    ])('refuses %s with VALIDATION', async (_label, fields) => {
      const res = await h.json('POST', '/moments', OWNER, { ...PHOTO, ...fields });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION' });
      expect(h.db.all(Moment)).toHaveLength(0);
    });
  });

  describe('complete verification', () => {
    it('answers 409 UPLOAD_INCOMPLETE while the object is missing, and keeps the moment to retry', async () => {
      const pending = await moment(OWNER, null, {}, false);

      const res = await h.json('POST', `/moments/${pending.id}/complete`, OWNER);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', reason: 'UPLOAD_INCOMPLETE' });
      expect(h.db.all(Moment)[0].status).toBe('pending');
    });

    it.each([
      ['a different size', 4096, 'image/jpeg'],
      ['a different type', 2048, 'image/png'],
      ['no type', 2048, null],
    ])('refuses %s with 409 UPLOAD_MISMATCH and deletes the moment and object', async (_label, size, type) => {
      const pending = await moment(OWNER, null, {}, false);
      const row = h.db.all(Moment)[0];
      storage.put(row.objectKey, size, type);

      const res = await h.json('POST', `/moments/${pending.id}/complete`, OWNER);

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', reason: 'UPLOAD_MISMATCH' });
      expect(h.db.all(Moment)).toHaveLength(0);
      expect(storage.deleted).toEqual([row.objectKey]);
    });

    it("lets only the uploader complete it (404 for anyone else, even the trip's owner)", async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      const pending = await moment(EDITOR, trip.id, {}, false);
      storage.put(h.db.all(Moment)[0].objectKey, PHOTO.byteSize);

      expect((await h.json('POST', `/moments/${pending.id}/complete`, OWNER)).status).toBe(404);
      expect((await h.json('POST', `/moments/${randomUUID()}/complete`, OWNER)).status).toBe(404);
      expect(h.db.all(Moment)[0].status).toBe('pending');
    });
  });

  describe('member and unassigned rules', () => {
    it('needs membership of the trip (any role) to add to it: others get 404', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [VIEWER, 'viewer']]);

      expect((await h.json('POST', '/moments', OTHER, { ...PHOTO, tripId: trip.id })).status).toBe(404);
      expect((await h.json('POST', '/moments', VIEWER, { ...PHOTO, tripId: trip.id })).status).toBe(201);
      expect((await h.json('GET', `/trips/${trip.id}/moments`, OTHER)).status).toBe(404);
    });

    it('keeps unassigned moments visible only to their author', async () => {
      const mine = await moment(OWNER, null);

      const own = await h.json<{ moments: MomentDto[] }>('GET', '/moments?unassigned=true', OWNER);
      expect(own.body.moments.map((m) => m.id)).toEqual([mine.id]);
      expect((await h.json<{ moments: MomentDto[] }>('GET', '/moments?unassigned=true', EDITOR)).body.moments).toEqual([]);
      expect((await h.json('DELETE', `/moments/${mine.id}`, EDITOR)).status).toBe(404);
      expect((await h.json('PATCH', `/moments/${mine.id}`, EDITOR, { tripId: null })).status).toBe(404);
      expect((await h.json('GET', '/moments', OWNER)).status).toBe(400);
    });

    it('moves a moment to a trip the uploader is a member of, or back to unassigned', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      const other = h.seedTrip([[OTHER, 'owner']]);
      const mine = await moment(EDITOR, null);

      expect((await h.json('PATCH', `/moments/${mine.id}`, EDITOR, { tripId: other.id })).status).toBe(404);
      const moved = await h.json<MomentDto>('PATCH', `/moments/${mine.id}`, EDITOR, { tripId: trip.id });
      expect(moved.status).toBe(200);
      expect(moved.body.tripId).toBe(trip.id);
      // A trip member who didn't take it can't move it.
      expect((await h.json('PATCH', `/moments/${mine.id}`, OWNER, { tripId: null })).status).toBe(403);
      expect((await h.json<MomentDto>('PATCH', `/moments/${mine.id}`, EDITOR, { tripId: null })).body.tripId).toBeNull();
      expect((await h.json('PATCH', `/moments/${mine.id}`, EDITOR, {})).status).toBe(400);
    });

    it('caps unassigned moments at 50 per user (409 UNASSIGNED_MOMENTS_LIMIT)', async () => {
      for (let i = 0; i < 50; i++) h.db.seed(Moment, seedRow(OWNER, null));

      const res = await h.json('POST', '/moments', OWNER, { ...PHOTO, tripId: null });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', reason: 'UNASSIGNED_MOMENTS_LIMIT' });
    });

    it('rate-limits uploads to 60 an hour per user (429 with Retry-After)', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      h.grantPlus(OWNER);
      for (let i = 0; i < 60; i++) expect((await h.json('POST', '/moments', OWNER, { ...PHOTO, tripId: trip.id })).status).toBe(201);

      const res = await h.call('POST', '/moments', OWNER, { ...PHOTO, tripId: trip.id });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3500);
      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO })).status).toBe(201);
    });
  });

  describe("the trip owner's plan limit", () => {
    it('refuses the 51st photo on a Free owner\'s trip with 402 MOMENTS_PLUS_REQUIRED and the limit, whoever uploads', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      for (let i = 0; i < 50; i++) h.db.seed(Moment, seedRow(OWNER, trip.id));

      const res = await h.json('POST', '/moments', EDITOR, { ...PHOTO, tripId: trip.id });

      expect(res.status).toBe(402);
      expect(res.body).toEqual({ code: 'PAYMENT_REQUIRED', reason: 'MOMENTS_PLUS_REQUIRED', limit: 50, message: expect.any(String) });
      // Moving one in is refused the same way.
      const loose = await moment(EDITOR, null);
      expect((await h.json('PATCH', `/moments/${loose.id}`, EDITOR, { tripId: trip.id })).status).toBe(402);
    });

    it("follows the owner's plan: Plus allows more, even for an editor on Free", async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      h.grantPlus(OWNER);
      for (let i = 0; i < 50; i++) h.db.seed(Moment, seedRow(OWNER, trip.id));

      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO, tripId: trip.id })).status).toBe(201);
    });
  });

  describe('deletion', () => {
    it('lets the uploader or the trip owner delete a moment, with its object; other members get 403', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);
      const first = await moment(EDITOR, trip.id);
      const second = await moment(EDITOR, trip.id);
      const [firstKey, secondKey] = [first.id, second.id].map((id) => h.db.all(Moment, { id })[0].objectKey);

      expect((await h.json('DELETE', `/moments/${first.id}`, VIEWER)).status).toBe(403);
      expect((await h.json('DELETE', `/moments/${first.id}`, OTHER)).status).toBe(404);
      expect((await h.call('DELETE', `/moments/${first.id}`, EDITOR)).status).toBe(204);
      expect((await h.call('DELETE', `/moments/${second.id}`, OWNER)).status).toBe(204);

      expect(h.db.all(Moment)).toEqual([]);
      expect(storage.deleted).toEqual([firstKey, secondKey]);
      expect(storage.objects.size).toBe(0);
    });

    it('still deletes the moment if deleting the object fails (logged)', async () => {
      const mine = await moment(OWNER, null);
      storage.failDeletes = true;

      expect((await h.call('DELETE', `/moments/${mine.id}`, OWNER)).status).toBe(204);
      expect(h.db.all(Moment)).toEqual([]);
      expect(logged.some((l) => l.includes(`Moment ${mine.id}: deleting its object failed`))).toBe(true);
    });

    it('leaves the photos of a deleted trip with their authors, unassigned', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      const photo = await moment(EDITOR, trip.id);

      expect((await h.call('DELETE', `/trips/${trip.id}`, OWNER)).status).toBe(204);

      expect(h.db.all(Trip)).toEqual([]);
      const own = await h.json<{ moments: MomentDto[] }>('GET', '/moments?unassigned=true', EDITOR);
      expect(own.body.moments.map((m) => m.id)).toEqual([photo.id]);
    });

    it("account deletion deletes the user's moments and their objects, and nobody else's", async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      const gone = [await moment(EDITOR, trip.id), await moment(EDITOR, null), await moment(EDITOR, trip.id, {}, false)];
      const kept = await moment(OWNER, trip.id);
      storage.put(h.db.all(Moment, { id: gone[2].id })[0].objectKey, 1);

      await h.moduleRef.get(UserDeletionHooks).run(EDITOR);

      expect(h.db.all(Moment).map((m) => m.id)).toEqual([kept.id]);
      expect(storage.deleted).toHaveLength(3);
      expect([...storage.objects.keys()]).toEqual([h.db.all(Moment)[0].objectKey]);
      expect(h.db.all(TripMember, { userId: EDITOR })).toEqual([]);
    });
  });

  describe('pending cleanup', () => {
    it('removes moments still pending after an hour, with any object, and keeps the rest', async () => {
      const old = h.db.seed(Moment, { ...seedRow(OWNER, null), status: 'pending', createdAt: new Date(Date.now() - 61 * 60_000) });
      const oldNoObject = h.db.seed(Moment, { ...seedRow(OWNER, null), status: 'pending', createdAt: new Date(Date.now() - 2 * 3_600_000) });
      const fresh = h.db.seed(Moment, { ...seedRow(OWNER, null), status: 'pending', createdAt: new Date(Date.now() - 30 * 60_000) });
      const ready = h.db.seed(Moment, { ...seedRow(OWNER, null), createdAt: new Date(Date.now() - 5 * 3_600_000) });
      storage.put(old.objectKey, 10);

      const removed = await h.moduleRef.get(MomentsService).cleanupPending();

      expect(removed).toBe(2);
      expect(h.db.all(Moment).map((m) => m.id).sort()).toEqual([fresh.id, ready.id].sort());
      expect(storage.deleted.sort()).toEqual([old.objectKey, oldNoObject.objectKey].sort());
    });

    it('never throws (a failure is logged)', async () => {
      h.db.seed(Moment, { ...seedRow(OWNER, null), status: 'pending', createdAt: new Date(Date.now() - 2 * 3_600_000) });
      h.db.beforeWrite = (operation) => {
        if (operation === 'delete') throw new Error('db down');
      };

      await expect(h.moduleRef.get(MomentsService).cleanupPending()).resolves.toBe(0);
      expect(logged.some((l) => l.includes('Pending moments cleanup failed: db down'))).toBe(true);
      h.db.beforeWrite = undefined;
    });
  });
});

/** A ready moment row for seeding. */
function seedRow(userId: string, tripId: string | null): Partial<Moment> {
  const id = randomUUID();
  return {
    id,
    userId,
    tripId,
    status: 'ready',
    objectKey: `moments/${userId}/${id}.jpg`,
    contentType: 'image/jpeg',
    byteSize: 100,
    width: 10,
    height: 10,
    takenAt: new Date(),
    takenOn: new Date().toISOString().slice(0, 10),
    completedAt: new Date(),
  };
}
