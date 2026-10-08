import { RateWindow } from './rate-window.js';
import { TtlLru } from './ttl-lru.js';
import { AppError } from './app-error.js';

describe('TtlLru', () => {
  it('expires entries after the TTL', () => {
    let now = 0;
    const cache = new TtlLru<string, number>(10, 1000, () => now);
    cache.set('a', 1);
    now = 999;
    expect(cache.get('a')).toBe(1);
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new TtlLru<string, number>(2, 60_000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([1, undefined, 3]);
    expect(cache.size).toBe(2);
  });

  it('caches null values', () => {
    const cache = new TtlLru<string, string | null>(2, 60_000);
    cache.set('a', null);
    expect(cache.get('a')).toBeNull();
  });
});

describe('RateWindow', () => {
  it('allows max calls per window per key, then RATE_LIMITED with the seconds until a slot frees', () => {
    const window = new RateWindow(2, 10_000, 'Slow down');
    window.take('u', 0);
    window.take('u', 4_000);
    const error = (() => {
      try {
        window.take('u', 5_000);
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', message: 'Slow down', options: { retryAfterSeconds: 5 } });
    window.take('v', 5_000);
    window.take('u', 10_001);
  });
});
