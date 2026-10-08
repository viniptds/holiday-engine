import { AppError } from './app-error.js';

/**
 * A per-key sliding-window limit kept in memory (per process): at most `max` calls per `windowMs`.
 * Over it → `429 RATE_LIMITED` with `Retry-After`. At most `maxKeys` keys are tracked (oldest dropped).
 */
export class RateWindow {
  private readonly calls = new Map<string, number[]>();

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly message: string,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one call for `key`, or throws RATE_LIMITED without counting it. */
  take(key: string, now = Date.now()): void {
    const recent = (this.calls.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.max) {
      this.calls.set(key, recent);
      throw new AppError('RATE_LIMITED', this.message, undefined, {
        retryAfterSeconds: (recent[recent.length - this.max] + this.windowMs - now) / 1000,
      });
    }
    recent.push(now);
    this.calls.delete(key);
    if (this.calls.size >= this.maxKeys) this.calls.delete(this.calls.keys().next().value!);
    this.calls.set(key, recent);
  }
}
