import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { FindOperator } from 'typeorm';
import { EventsModule } from './events.module.js';
import { EventsService, REQUEST_SUGGESTIONS_LIMIT, requestWindow } from './events.service.js';
import { SuggestedEvent } from './suggested-event.entity.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { Event, EventsProvider } from './events.types.js';

/**
 * In-memory stand-in for the `suggested_events` repository: implements just the
 * `find({ where: { tripId, externalId: In(ids) } })` lookup and the
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING "externalId"` chain the service builds.
 */
function inMemorySuggestedEvents() {
  const sent = new Set<string>();
  const createQueryBuilder = () => {
    let rows: { tripId: string; externalId: string }[] = [];
    const qb = {
      insert: () => qb,
      into: () => qb,
      values: (values: { tripId: string; externalId: string }[]) => ((rows = values), qb),
      orIgnore: () => qb,
      returning: () => qb,
      execute: async () => {
        const inserted = rows.filter((r) => !sent.has(`${r.tripId}|${r.externalId}`));
        inserted.forEach((r) => sent.add(`${r.tripId}|${r.externalId}`));
        return { raw: inserted.map(({ externalId }) => ({ externalId })) };
      },
    };
    return qb;
  };
  const find = async ({ where }: { where: { tripId: string; externalId: FindOperator<string[]> } }) =>
    (where.externalId.value as string[])
      .filter((externalId) => sent.has(`${where.tripId}|${externalId}`))
      .map((externalId) => ({ externalId }));
  return { sent, repo: { createQueryBuilder, find } };
}

/** Feature tests: EventsModule wired with the real mock provider, as the engine would use it. */
describe('Event suggestions (feature)', () => {
  let service: EventsService;
  let store: ReturnType<typeof inMemorySuggestedEvents>;
  const trip = { id: 't1', destination: 'Lisbon', startDate: '2026-11-10', endDate: '2026-11-15' };
  const contractKeys = ['category', 'city', 'externalId', 'name', 'startsAt', 'url', 'venue'];

  beforeEach(async () => {
    store = inMemorySuggestedEvents();
    const moduleRef = await Test.createTestingModule({ imports: [EventsModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: () => undefined })
      .overrideProvider(getRepositoryToken(SuggestedEvent))
      .useValue(store.repo)
      .compile();
    service = moduleRef.get(EventsService);
  });

  it('suggests at most 5 contract-shaped events inside the trip, sorted by start', async () => {
    const events = await service.suggestForRequest(trip, new Date('2026-10-03T12:00:00.000Z'));

    expect(events).toHaveLength(REQUEST_SUGGESTIONS_LIMIT);
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(contractKeys);
      expect(event.startsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(event.startsAt >= '2026-11-10' && event.startsAt <= '2026-11-15T23:59:59.999Z').toBe(true);
      expect(event.city).toBe('Lisbon');
    }
    const starts = events.map((e) => e.startsAt);
    expect(starts).toEqual([...starts].sort());
  });

  it('is deterministic across requests', async () => {
    const today = new Date('2026-10-03T12:00:00.000Z');

    expect(await service.suggestForRequest(trip, today)).toEqual(await service.suggestForRequest(trip, today));
  });

  it('only suggests remaining days for a trip in progress', async () => {
    const events = await service.suggestForRequest(trip, new Date('2026-11-14T08:00:00.000Z'));

    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.startsAt >= '2026-11-14')).toBe(true);
  });

  it('suggests nothing for a finished trip', async () => {
    expect(await service.suggestForRequest(trip, new Date('2026-11-16T00:00:00.000Z'))).toEqual([]);
  });

  it('covers a one-day trip on that day', async () => {
    const oneDay = { ...trip, startDate: '2026-11-10', endDate: '2026-11-10' };

    expect(requestWindow(oneDay, new Date('2026-11-10T23:00:00.000Z'))).toEqual({
      from: new Date('2026-11-10T00:00:00.000Z'),
      to: new Date('2026-11-10T23:59:59.999Z'),
    });
  });

  describe('scheduled suggestions (contract: skip events already sent for the trip)', () => {
    const day = new Date('2026-11-12T09:00:00.000Z');

    it('suggests today and tomorrow on the first run and records them', async () => {
      const events = await service.suggestScheduled(trip, day);

      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.startsAt >= '2026-11-12' && e.startsAt <= '2026-11-13T23:59:59.999Z')).toBe(true);
      expect(store.sent.size).toBe(events.length);
    });

    it('sends what is left on a same-day re-run, then nothing', async () => {
      const first = await service.suggestScheduled(trip, day);
      const second = await service.suggestScheduled(trip, day);

      expect(first).toHaveLength(5);
      const firstIds = new Set(first.map((e) => e.externalId));
      expect(second.length).toBeGreaterThan(0);
      expect(second.filter((e) => firstIds.has(e.externalId))).toEqual([]);
      expect(store.sent.size).toBe(first.length + second.length);
      expect(await service.suggestScheduled(trip, day)).toEqual([]);
    });

    it('only returns unseen events on the next day (overlapping window)', async () => {
      const first = await service.suggestScheduled(trip, day);
      const second = await service.suggestScheduled(trip, new Date('2026-11-13T09:00:00.000Z'));

      const firstIds = new Set(first.map((e) => e.externalId));
      expect(second.every((e) => !firstIds.has(e.externalId))).toBe(true);
    });

    it('dedupes per trip, not globally', async () => {
      const a = await service.suggestScheduled(trip, day);
      const b = await service.suggestScheduled({ ...trip, id: 't2' }, day);

      expect(b).toEqual(a);
    });
  });

  // BUG-008 (fixed): an unbounded endDate (validators allow any year) makes the mock provider loop over every day.
  it('bounds the search window for very long trips', () => {
    const window = requestWindow({ ...trip, endDate: '9999-12-31' }, new Date('2026-10-03T00:00:00.000Z'));

    expect(window!.to.getUTCFullYear()).toBeLessThan(9999);
  });

  // BUG-009 (fixed): the limit was applied before dedupe, so a busy city kept returning the same first 5.
  it('reaches events beyond the first 5 on later runs when the window is busy', async () => {
    const busy: Event[] = Array.from({ length: 10 }, (_, i) => ({
      externalId: `e${i}`,
      name: `Event ${i}`,
      startsAt: `2026-11-12T1${i}:00:00.000Z`,
      venue: null,
      city: 'Lisbon',
      url: null,
      category: null,
    }));
    const provider: EventsProvider = {
      search: async ({ from, to, limit }) =>
        busy.filter((e) => new Date(e.startsAt) >= from && new Date(e.startsAt) <= to).slice(0, limit),
    };
    const moduleRef = await Test.createTestingModule({ imports: [EventsModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: () => undefined })
      .overrideProvider(getRepositoryToken(SuggestedEvent))
      .useValue(inMemorySuggestedEvents().repo)
      .overrideProvider(EVENTS_PROVIDER)
      .useValue(provider)
      .compile();
    const busyService = moduleRef.get(EventsService);
    const today = new Date('2026-11-12T09:00:00.000Z');

    await busyService.suggestScheduled(trip, today);
    const second = await busyService.suggestScheduled(trip, today);

    expect(second.map((e) => e.externalId)).toEqual(['e5', 'e6', 'e7', 'e8', 'e9']);
  });
});
