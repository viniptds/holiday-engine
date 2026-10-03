import { MockEventsProvider } from './mock-events.provider.js';

const from = new Date('2026-11-01T00:00:00.000Z');
const to = new Date('2026-11-05T23:59:59.999Z');

describe('MockEventsProvider', () => {
  const provider = new MockEventsProvider();

  it('returns the same events for the same city and range', async () => {
    const first = await provider.search({ city: 'Lisbon', from, to, limit: 50 });
    const second = await new MockEventsProvider().search({ city: 'Lisbon', from, to, limit: 50 });

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it('gives different events for different cities', async () => {
    const lisbon = await provider.search({ city: 'Lisbon', from, to, limit: 50 });
    const rome = await provider.search({ city: 'Rome', from, to, limit: 50 });

    expect(rome.map((e) => e.name)).not.toEqual(lisbon.map((e) => e.name));
    expect(rome.every((e) => e.city === 'Rome')).toBe(true);
  });

  it('keeps event ids stable across overlapping ranges', async () => {
    const wide = await provider.search({ city: 'Lisbon', from, to, limit: 50 });
    const narrow = await provider.search({
      city: 'Lisbon',
      from: new Date('2026-11-03T00:00:00.000Z'),
      to: new Date('2026-11-03T23:59:59.999Z'),
      limit: 50,
    });

    expect(narrow.length).toBeGreaterThan(0);
    expect(wide).toEqual(expect.arrayContaining(narrow));
  });

  it('returns well-formed events inside the range, sorted by start', async () => {
    const events = await provider.search({ city: 'São Paulo', from, to, limit: 50 });

    for (const event of events) {
      const startsAt = new Date(event.startsAt);
      expect(startsAt.getTime()).toBeGreaterThanOrEqual(from.getTime());
      expect(startsAt.getTime()).toBeLessThanOrEqual(to.getTime());
      expect(event.externalId).toMatch(/^mock-sao-paulo-2026-11-0\d-\d$/);
      expect(event.name).toContain('São Paulo');
    }
    const starts = events.map((e) => e.startsAt);
    expect(starts).toEqual([...starts].sort());
    expect(new Set(events.map((e) => e.externalId)).size).toBe(events.length);
    expect(new Set(events.map((e) => e.category)).size).toBeGreaterThan(1);
  });

  it('excludes events outside a range that starts or ends mid-day', async () => {
    const midFrom = new Date('2026-11-02T15:00:00.000Z');
    const midTo = new Date('2026-11-03T12:00:00.000Z');
    const events = await provider.search({ city: 'Lisbon', from: midFrom, to: midTo, limit: 50 });

    for (const event of events) {
      expect(new Date(event.startsAt) >= midFrom && new Date(event.startsAt) <= midTo).toBe(true);
    }
  });

  it('respects the limit', async () => {
    expect(await provider.search({ city: 'Lisbon', from, to, limit: 2 })).toHaveLength(2);
    expect(await provider.search({ city: 'Lisbon', from, to, limit: 0 })).toEqual([]);
  });

  it('returns nothing for an empty range', async () => {
    expect(await provider.search({ city: 'Lisbon', from: to, to: from, limit: 5 })).toEqual([]);
  });
});
