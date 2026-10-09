import { bigTripHorizon, isoWeek, longWeekendDays, seededRandom } from './banners.service.js';

describe('banner selection rules (pure)', () => {
  it('seeds a deterministic sequence per user and ISO week, different between users and weeks', () => {
    const a = seededRandom('user-a:2026-W41');
    const b = seededRandom('user-a:2026-W41');
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const other = seededRandom('user-b:2026-W41');
    const nextWeek = seededRandom('user-a:2026-W42');
    expect([a(), a()]).not.toEqual([other(), other()]);
    expect(seededRandom('user-a:2026-W41')()).not.toBe(nextWeek());
    for (let i = 0; i < 100; i += 1) {
      const n = a();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('computes ISO weeks (year boundaries included)', () => {
    expect(isoWeek(new Date('2026-10-09T10:00:00Z'))).toBe('2026-W41');
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-12-31T23:59:59Z'))).toBe('2026-W53');
  });

  it('turns a holiday into a 3 or 4 day block with the weekend, or none', () => {
    expect(longWeekendDays('2026-10-12')).toBe(3); // Monday
    expect(longWeekendDays('2026-10-16')).toBe(3); // Friday
    expect(longWeekendDays('2026-10-13')).toBe(4); // Tuesday (Monday bridge)
    expect(longWeekendDays('2026-10-15')).toBe(4); // Thursday (Friday bridge)
    expect(longWeekendDays('2026-10-14')).toBeNull(); // Wednesday
    expect(longWeekendDays('2026-10-17')).toBeNull(); // Saturday
    expect(longWeekendDays('2026-10-18')).toBeNull(); // Sunday
  });

  it('picks the big-trip horizon from what is already planned', () => {
    const today = '2026-10-09';
    expect(bigTripHorizon([], today)).toBe(3);
    expect(bigTripHorizon(['2026-09-01'], today)).toBe(3); // past trips don't count
    expect(bigTripHorizon(['2026-11-20'], today)).toBe(6); // within 3 months
    expect(bigTripHorizon(['2026-11-20', '2027-02-15'], today)).toBe(12); // and another within 3-6
    expect(bigTripHorizon(['2027-02-15'], today)).toBe(3); // only a trip 4 months out: the next 3 months are free
    expect(bigTripHorizon(['2027-09-01'], today)).toBe(3);
  });
});
