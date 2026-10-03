import { addUtcDays, endOfUtcDay, formatDateOnly, parseDateOnly, startOfUtcDay } from './events.dates.js';

describe('startOfUtcDay', () => {
  it('truncates to midnight UTC', () => {
    expect(startOfUtcDay(new Date('2026-11-03T23:59:59.999Z'))).toEqual(new Date('2026-11-03T00:00:00.000Z'));
  });

  it('is a no-op at midnight', () => {
    expect(startOfUtcDay(new Date('2026-11-03T00:00:00.000Z'))).toEqual(new Date('2026-11-03T00:00:00.000Z'));
  });

  it('does not mutate its input', () => {
    const input = new Date('2026-11-03T12:00:00.000Z');
    startOfUtcDay(input);
    expect(input.toISOString()).toBe('2026-11-03T12:00:00.000Z');
  });
});

describe('endOfUtcDay', () => {
  it('returns the last millisecond of the UTC day', () => {
    expect(endOfUtcDay(new Date('2026-11-03T00:00:00.000Z'))).toEqual(new Date('2026-11-03T23:59:59.999Z'));
  });

  it('handles month and year boundaries', () => {
    expect(endOfUtcDay(new Date('2026-12-31T10:00:00.000Z'))).toEqual(new Date('2026-12-31T23:59:59.999Z'));
  });
});

describe('addUtcDays', () => {
  it('adds and subtracts whole days', () => {
    expect(addUtcDays(new Date('2026-02-28T00:00:00.000Z'), 1)).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(addUtcDays(new Date('2028-02-28T00:00:00.000Z'), 1)).toEqual(new Date('2028-02-29T00:00:00.000Z'));
    expect(addUtcDays(new Date('2026-01-01T00:00:00.000Z'), -1)).toEqual(new Date('2025-12-31T00:00:00.000Z'));
  });
});

describe('parseDateOnly', () => {
  it('parses YYYY-MM-DD as midnight UTC', () => {
    expect(parseDateOnly('2026-11-03')).toEqual(new Date('2026-11-03T00:00:00.000Z'));
  });

  it.each(['2026-11-3', '03/11/2026', '2026-11-03T00:00:00Z', '', 'tomorrow', '2026-13-01'])(
    'rejects %p',
    (value) => {
      expect(() => parseDateOnly(value)).toThrow(`Invalid date "${value}", expected YYYY-MM-DD`);
    },
  );

  // BUG-007 (fixed): JS Date rolls impossible days over instead of failing (2026-02-30 -> 2026-03-02).
  it('rejects impossible calendar dates like 2026-02-30', () => {
    expect(() => parseDateOnly('2026-02-30')).toThrow();
  });
});

describe('formatDateOnly', () => {
  it('formats in UTC', () => {
    expect(formatDateOnly(new Date('2026-11-03T23:30:00.000Z'))).toBe('2026-11-03');
  });

  it('round-trips with parseDateOnly', () => {
    expect(formatDateOnly(parseDateOnly('2028-02-29'))).toBe('2028-02-29');
  });
});
