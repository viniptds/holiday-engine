import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { User } from '../users/user.entity.js';
import { Moment } from './moment.entity.js';
import { MomentsService } from './moments.service.js';
import { UPLOAD_RATE_LIMIT } from './moments.types.js';
import type { CreatedMomentDto, MomentDto } from './moments.types.js';
import { RateWindow } from '../app-common/rate-window.js';
import { MemoryObjectStorage } from './testing/moments-testing.js';
import { bootMoments, EDITOR, OTHER, OWNER, VIEWER } from './testing/harness.js';
import type { Harness } from './testing/harness.js';
import type { JourneyNode } from '../achievements/achievements.types.js';

const PHOTO = { contentType: 'image/jpeg', byteSize: 100, width: 10, height: 10 };
// A three-day trip in the past (so no day is locked in the Journey).
const TRIP = { startDate: '2026-03-10', endDate: '2026-03-12' };

describe('Moment days: camera and uploads (feature)', () => {
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
    Object.assign(h.moduleRef.get(MomentsService), {
      uploads: new RateWindow(UPLOAD_RATE_LIMIT.max, UPLOAD_RATE_LIMIT.windowMs, 'Too many photo uploads. Please wait a little.'),
    });
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const team = () => h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']], TRIP);

  /** Creates, uploads and completes a moment; `zone` is the X-Timezone of the complete call. */
  async function add(user: string, body: Record<string, unknown>, zone?: string): Promise<MomentDto> {
    const created = await h.json<CreatedMomentDto>('POST', '/moments', user, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', ...body });
    expect(created.status).toBe(201);
    storage.put(h.db.all(Moment, { id: created.body.moment.id })[0].objectKey, PHOTO.byteSize);
    const done = await h.json<MomentDto>('POST', `/moments/${created.body.moment.id}/complete`, user, undefined, zone ? { 'x-timezone': zone } : {});
    expect(done.status).toBe(200);
    return done.body;
  }

  describe('camera moments: the day comes from takenAt in the uploader\'s time zone, at complete', () => {
    // 01:30 UTC on the 11th: still the 10th in São Paulo (UTC-3), already the 11th in Tokyo and UTC.
    it.each([
      ['America/Sao_Paulo', 1],
      ['Asia/Tokyo', 2],
      [undefined, 2],
    ])('X-Timezone %s → day %i', async (zone, day) => {
      const trip = team();
      const moment = await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-11T01:30:00Z' }, zone);

      expect(moment).toMatchObject({ source: 'camera', day, dayEditable: false });
    });

    it("falls back to the user's stored zone, then UTC", async () => {
      const trip = team();
      await h.db.repository(User).update({ id: EDITOR }, { timezone: 'America/Sao_Paulo' });

      // No X-Timezone: the auth guard reads the stored zone on each request.
      const moment = await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-11T01:30:00Z' });

      expect(moment.day).toBe(1);
    });

    it('is null when the photo was taken outside the trip, or has no trip', async () => {
      const trip = team();
      expect((await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-13T12:00:00Z' })).day).toBeNull();
      expect((await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-09T12:00:00Z' })).day).toBeNull();
      expect((await add(EDITOR, { tripId: null })).day).toBeNull();
    });

    it.each([2, null])('refuses a client-sent day (%p) with 400', async (day) => {
      const trip = team();
      const res = await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id, day });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION', fields: { day: expect.any(String) } });
      const explicit = await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id, source: 'camera', day });
      expect(explicit.status).toBe(400);
    });

    it('never changes day: 409 MOMENT_DAY_LOCKED for the uploader and the owner', async () => {
      const trip = team();
      const moment = await add(EDITOR, { tripId: trip.id });

      for (const user of [EDITOR, OWNER]) {
        const res = await h.json('PATCH', `/moments/${moment.id}`, user, { day: 3 });
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ code: 'CONFLICT', reason: 'MOMENT_DAY_LOCKED' });
      }
      expect(h.db.all(Moment)[0].day).toBe(2);
    });
  });

  describe('uploads', () => {
    it('keep the chosen day (or none), and the uploader and the trip owner can edit it', async () => {
      const trip = team();
      const withDay = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 3, takenAt: '2025-01-01T00:00:00Z' });
      const noDay = await add(EDITOR, { tripId: trip.id, source: 'upload', day: null });
      const unspecified = await add(EDITOR, { tripId: trip.id, source: 'upload' });

      expect(withDay).toMatchObject({ source: 'upload', day: 3, dayEditable: true });
      expect([noDay.day, unspecified.day]).toEqual([null, null]);
      const listed = async (user: string) =>
        (await h.json<{ moments: MomentDto[] }>('GET', `/trips/${trip.id}/moments`, user)).body.moments.find((m) => m.id === withDay.id)!;
      expect((await listed(OWNER)).dayEditable).toBe(true);
      expect((await listed(VIEWER)).dayEditable).toBe(false);
    });

    it.each([
      [0, 'below 1'],
      [4, 'past the trip (3 days)'],
      [1.5, 'not a whole number'],
    ])('refuses day %p (%s) with 400', async (day) => {
      const trip = team();
      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id, source: 'upload', day })).status).toBe(400);
    });

    it('refuses a day without a trip, and an unknown source', async () => {
      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', source: 'upload', day: 1 })).status).toBe(400);
      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', source: 'scanner' })).status).toBe(400);
    });

    it.each([
      [EDITOR, 200, 'the uploader'],
      [OWNER, 200, 'the trip owner'],
      [VIEWER, 403, 'another member'],
      [OTHER, 404, 'a non-member'],
    ])('PATCH day: %s (%s) → %i', async (user, status) => {
      const trip = team();
      const moment = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 1 });

      const res = await h.json<MomentDto>('PATCH', `/moments/${moment.id}`, user, { day: 2 });

      expect(res.status).toBe(status);
      expect(h.db.all(Moment)[0].day).toBe(status === 200 ? 2 : 1);
      if (status === 200) expect(res.body).toMatchObject({ day: 2, dayEditable: true });
    });

    it('PATCH day validates the day and allows null', async () => {
      const trip = team();
      const moment = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 1 });

      expect((await h.json('PATCH', `/moments/${moment.id}`, EDITOR, { day: 4 })).status).toBe(400);
      expect((await h.json('PATCH', `/moments/${moment.id}`, EDITOR, { day: 0 })).status).toBe(400);
      expect((await h.json('PATCH', `/moments/${moment.id}`, EDITOR, {})).status).toBe(400);
      expect((await h.json<MomentDto>('PATCH', `/moments/${moment.id}`, EDITOR, { day: null })).body.day).toBeNull();
    });

    it('both sources count toward the per-trip limit', async () => {
      const trip = team();
      for (let i = 0; i < 25; i++) await h.json('POST', '/moments', OWNER, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id });
      for (let i = 0; i < 25; i++) await h.json('POST', '/moments', OWNER, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id, source: 'upload' });

      expect((await h.json('POST', '/moments', EDITOR, { ...PHOTO, takenAt: '2026-03-11T12:00:00Z', tripId: trip.id, source: 'upload' })).body).toMatchObject({
        reason: 'MOMENTS_PLUS_REQUIRED',
        limit: 50,
      });
    });
  });

  describe('moving and date changes', () => {
    it('resets an upload\'s day and recalculates a camera day when the moment moves to another trip', async () => {
      const trip = team();
      const later = h.seedTrip([[EDITOR, 'owner']], { startDate: '2026-03-11', endDate: '2026-03-20' });
      const upload = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 3 });
      const camera = await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-12T12:00:00Z' });

      expect((await h.json<MomentDto>('PATCH', `/moments/${upload.id}`, EDITOR, { tripId: later.id })).body).toMatchObject({ tripId: later.id, day: null });
      expect((await h.json<MomentDto>('PATCH', `/moments/${camera.id}`, EDITOR, { tripId: later.id })).body).toMatchObject({ tripId: later.id, day: 2 });
      expect((await h.json<MomentDto>('PATCH', `/moments/${camera.id}`, EDITOR, { tripId: null })).body.day).toBeNull();
      // A move and a day together: the day is checked against the new trip.
      expect((await h.json<MomentDto>('PATCH', `/moments/${upload.id}`, EDITOR, { tripId: trip.id, day: 2 })).body).toMatchObject({ tripId: trip.id, day: 2 });
    });

    it('shifts days when the trip dates change: uploads past the end lose their day, camera days follow takenAt', async () => {
      const trip = team();
      const lastDay = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 3 });
      const firstDay = await add(EDITOR, { tripId: trip.id, source: 'upload', day: 1 });
      const camera = await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-12T12:00:00Z' });
      expect(camera.day).toBe(3);

      const res = await h.json('PATCH', `/trips/${trip.id}`, OWNER, { startDate: '2026-03-09', endDate: '2026-03-10' });

      expect(res.status).toBe(200);
      const day = (id: string) => h.db.all(Moment, { id })[0].day;
      expect([day(lastDay.id), day(firstDay.id), day(camera.id)]).toEqual([null, 1, null]);

      await h.json('PATCH', `/trips/${trip.id}`, OWNER, { endDate: '2026-03-15' });
      expect(day(camera.id)).toBe(4);
    });
  });

  it('counts uploads in the Journey: day_completed and the day thumbnails use the day', async () => {
    const trip = team();
    await add(EDITOR, { tripId: trip.id, source: 'upload', day: 2, takenAt: '2024-01-01T00:00:00Z' });
    await add(EDITOR, { tripId: trip.id, takenAt: '2026-03-10T12:00:00Z' });

    const { body } = await h.json<{ nodes: JourneyNode[] }>('GET', `/trips/${trip.id}/journey`, OWNER);

    const days = body.nodes.filter((n) => n.kind === 'day');
    expect(days.map((n) => [n.key, n.status, n.momentThumbs?.length])).toEqual([
      ['day_completed:1', 'done', 1],
      ['day_completed:2', 'done', 1],
      ['day_completed:3', expect.stringMatching(/current|todo/), 0],
    ]);
  });
});
