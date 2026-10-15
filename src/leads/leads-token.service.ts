import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { TtlLru } from '../app-common/ttl-lru.js';
import { LEADS_CONFIG } from './leads.config.js';
import type { LeadsConfig } from './leads.config.js';

export const TOKEN_TTL_SECONDS = 600;
export const MAX_REDEEMED_NONCES = 50_000;
const CLOCK_SKEW_MS = 60_000;

type Payload = { nonce: string; iat: number; origin: string };

/**
 * The form token (CSRF-style guard): `base64url(payload).base64url(hmac)`, payload `{ nonce, iat, origin }`,
 * HMAC-SHA256 over `LEADS_TOKEN_SECRET`. Valid 10 minutes, single use: a redeemed nonce is remembered
 * in a bounded in-memory LRU (per process, so a restart or a second instance forgets it).
 */
@Injectable()
export class LeadsTokenService {
  /** Tests move this through time. */
  now: () => number = Date.now;
  private redeemed = new TtlLru<string, true>(MAX_REDEEMED_NONCES, (TOKEN_TTL_SECONDS + 120) * 1000, () => this.now());

  constructor(@Inject(LEADS_CONFIG) private readonly config: LeadsConfig) {}

  issue(origin: string): { token: string; expiresInSeconds: number } {
    const payload: Payload = { nonce: randomBytes(16).toString('base64url'), iat: this.now(), origin };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, expiresInSeconds: TOKEN_TTL_SECONDS };
  }

  /** True once per valid token issued for `origin`; false for anything tampered, expired, reused or for another origin. */
  redeem(token: unknown, origin: string): boolean {
    if (typeof token !== 'string' || token.length > 1000) return false;
    const [body, signature, extra] = token.split('.');
    if (!body || !signature || extra !== undefined) return false;
    const expected = Buffer.from(this.sign(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;

    let payload: Payload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    } catch {
      return false;
    }
    if (typeof payload.nonce !== 'string' || typeof payload.iat !== 'number' || payload.origin !== origin) return false;
    const age = this.now() - payload.iat;
    if (age > TOKEN_TTL_SECONDS * 1000 || age < -CLOCK_SKEW_MS) return false;
    if (this.redeemed.get(payload.nonce)) return false;
    this.redeemed.set(payload.nonce, true);
    return true;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.config.tokenSecret).update(body).digest('base64url');
  }
}
