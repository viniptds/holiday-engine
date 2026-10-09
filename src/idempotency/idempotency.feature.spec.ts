import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { ChecklistItem } from '../checklist/checklist.entities.js';
import { bootMoments, EDITOR, OWNER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import { IdempotencyKey } from './idempotency-key.entity.js';
import { IdempotencyStore } from './idempotency.interceptor.js';

const TRIP = { destination: 'Lisbon', startDate: '2027-05-01', endDate: '2027-05-03' };

describe('Idempotency-Key and overwroteNewer (feature)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootMoments();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.db.clear();
    h.seedUsers();
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const key = () => randomUUID();
  const withKey = (k: string) => ({ 'idempotency-key': k });
  const ownTrips = () => h.db.all(Trip, { ownerUserId: OWNER });

  it('replays POST /trips: the stored response, the same status, no second trip', async () => {
    const k = key();
    const first = await h.json<{ id: string }>('POST', '/trips', OWNER, TRIP, withKey(k));
    const again = await h.json<{ id: string }>('POST', '/trips', OWNER, TRIP, withKey(k));

    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(ownTrips()).toHaveLength(1);
    // Another user's identical key is theirs alone.
    expect((await h.json<{ id: string }>('POST', '/trips', EDITOR, TRIP, withKey(k))).body.id).not.toBe(first.body.id);
  });

  it('refuses the same key on another path or method with 422 VALIDATION', async () => {
    const k = key();
    const created = await h.json<{ id: string }>('POST', '/trips', OWNER, TRIP, withKey(k));

    const otherPath = await h.json('PATCH', `/trips/${created.body.id}`, OWNER, { notes: 'x' }, withKey(k));
    expect(otherPath.status).toBe(422);
    expect(otherPath.body).toMatchObject({ code: 'VALIDATION', fields: { 'Idempotency-Key': expect.any(String) } });
    const checklist = await h.json('POST', `/trips/${created.body.id}/checklist`, OWNER, { title: 'Passport' }, withKey(k));
    expect(checklist.status).toBe(422);
    expect(h.db.all(ChecklistItem)).toEqual([]);
  });

  it("doesn't store failures (a fixed retry with the same key goes through), and needs a UUID", async () => {
    const k = key();
    expect((await h.json('POST', '/trips', OWNER, { ...TRIP, endDate: '2027-04-01' }, withKey(k))).status).toBe(400);
    expect((await h.json('POST', '/trips', OWNER, TRIP, withKey(k))).status).toBe(201);
    expect((await h.json('POST', '/trips', OWNER, TRIP, withKey('not-a-uuid'))).status).toBe(400);
    expect(ownTrips()).toHaveLength(1);
  });

  it('expires after 24 hours (the cleanup removes old keys)', async () => {
    const k = key();
    await h.json('POST', '/trips', OWNER, TRIP, withKey(k));
    await h.db.repository(IdempotencyKey).update({ userId: OWNER, key: k }, { createdAt: new Date(Date.now() - 25 * 3_600_000) });

    expect((await h.json('POST', '/trips', OWNER, TRIP, withKey(k))).status).toBe(201);
    expect(ownTrips()).toHaveLength(2);

    await h.db.repository(IdempotencyKey).update({ userId: OWNER, key: k }, { createdAt: new Date(Date.now() - 25 * 3_600_000) });
    await h.moduleRef.get(IdempotencyStore).cleanup();
    expect(h.db.all(IdempotencyKey)).toEqual([]);
  });

  it('answers 409 REQUEST_IN_PROGRESS while the first request is still running', async () => {
    const k = key();
    h.db.seed(IdempotencyKey, { userId: OWNER, key: k, method: 'POST', path: '/app/v1/trips', status: 0, responseBody: null });
    const res = await h.json('POST', '/trips', OWNER, TRIP, withKey(k));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: 'REQUEST_IN_PROGRESS' });
  });

  it('covers the offline queue\'s other writes: trip PATCH, itinerary PUT, place PATCH and every checklist write', async () => {
    const trip = h.seedTrip([[OWNER, 'owner']], { startDate: '2027-05-01', endDate: '2027-05-03' });
    const place = h.db.seed(TripPlace, {
      tripId: trip.id, googlePlaceId: 'mock-1', name: 'A', address: 'a', lat: 0, lng: 0, rating: null, mapsUrl: null,
      types: [], category: 'other', day: null, position: 0, source: 'user', createdBy: OWNER,
    } as Partial<TripPlace>);
    const replay = async (method: string, path: string, body?: unknown) => {
      const k = key();
      const first = await h.json(method, path, OWNER, body, withKey(k));
      const again = await h.json(method, path, OWNER, body, withKey(k));
      expect(again.status).toBe(first.status);
      expect(again.body).toEqual(first.body);
      return first;
    };

    await replay('PATCH', `/trips/${trip.id}`, { notes: 'offline note' });
    const put = await replay('PUT', `/trips/${trip.id}/itinerary`, { itineraryVersion: 0, days: [{ day: 1, placeIds: [place.id] }] });
    expect(put.status).toBe(200);
    // Replayed, not re-applied: the version moved once.
    expect(h.db.all(Trip, { id: trip.id })[0].itineraryVersion).toBe(1);
    await replay('PATCH', `/trips/${trip.id}/places/${place.id}`, { notes: 'x' });

    const created = await replay('POST', `/trips/${trip.id}/checklist`, { title: 'Passport' });
    expect(h.db.all(ChecklistItem)).toHaveLength(1);
    await replay('POST', `/trips/${trip.id}/checklist/bulk`, { items: [{ title: 'A' }, { title: 'B' }] });
    expect(h.db.all(ChecklistItem)).toHaveLength(3);
    const itemId = (created.body as { id: string }).id;
    await replay('PATCH', `/trips/${trip.id}/checklist/${itemId}`, { done: true });
    await replay('PUT', `/trips/${trip.id}/checklist/order`, { itemIds: h.db.all(ChecklistItem).map((i) => i.id).reverse() });
    const deleted = await replay('DELETE', `/trips/${trip.id}/checklist/${itemId}`);
    expect(deleted.status).toBe(204);
    expect(h.db.all(ChecklistItem)).toHaveLength(2);
  });

  describe('PATCH /trips/:id baseUpdatedAt', () => {
    it('applies the change either way and says overwroteNewer when the trip had changed since', async () => {
      const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
      const seen = new Date(h.db.all(Trip, { id: trip.id })[0].updatedAt).toISOString();

      const first = await h.json<{ notes: string; overwroteNewer?: boolean; updatedAt: string }>('PATCH', `/trips/${trip.id}`, EDITOR, { notes: 'editor', baseUpdatedAt: seen });
      expect(first.body).not.toHaveProperty('overwroteNewer');

      const stale = await h.json<{ notes: string; overwroteNewer?: boolean }>('PATCH', `/trips/${trip.id}`, OWNER, { notes: 'owner offline', baseUpdatedAt: new Date(Date.parse(first.body.updatedAt) - 1000).toISOString() });
      expect(stale.body).toMatchObject({ notes: 'owner offline', overwroteNewer: true });

      expect((await h.json('PATCH', `/trips/${trip.id}`, OWNER, { notes: 'plain' })).body).not.toHaveProperty('overwroteNewer');
      expect((await h.json('PATCH', `/trips/${trip.id}`, OWNER, { baseUpdatedAt: 'yesterday' })).status).toBe(400);
    });
  });
});
