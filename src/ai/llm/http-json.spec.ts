import { backoffMs, retryAfterMs } from './http-json.js';

describe('retryAfterMs', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('Sat, 03 Oct 2026 12:00:10 GMT', Date.parse('2026-10-03T12:00:00Z'))).toBe(10_000);
  });

  it('returns null without a usable header', () => {
    expect(retryAfterMs(null)).toBeNull();
    expect(retryAfterMs('soon')).toBeNull();
  });
});

describe('backoffMs', () => {
  it('grows exponentially with full jitter, capped at 8 s', () => {
    expect(backoffMs(0, () => 0.999)).toBe(499);
    expect(backoffMs(1, () => 0.999)).toBe(999);
    expect(backoffMs(10, () => 0.999)).toBe(7992);
    expect(backoffMs(3, () => 0)).toBe(0);
  });
});
