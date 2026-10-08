import type { EntitlementStatus } from './user-entitlement.entity.js';

/** `/me` → `plan` (docs/app-subscriptions-spec.md). */
export type PlanDto = {
  tier: 'free' | 'plus';
  status: EntitlementStatus | null;
  expiresAt: string | null;
  willRenew: boolean | null;
  store: string | null;
};

/** `/me` → `aiQuota`. `limit`/`remaining` null for Plus (no daily quota). */
export type AiQuotaDto = { limit: number | null; used: number; remaining: number | null; resetsAt: string };

/** `/me` → `limits`. */
export type LimitsDto = { tripPlaces: number };

export const SYNC_RATE_LIMIT = { max: 20, windowMs: 60 * 60 * 1000 };
