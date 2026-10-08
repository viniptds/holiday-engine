import type { ConfigService } from '@nestjs/config';
import { MAX_TRIP_PLACES } from '../ai/ai.types.js';

export const BILLING_PROVIDERS = ['revenuecat', 'mock'] as const;
export type BillingProviderName = (typeof BILLING_PROVIDERS)[number];

export type BillingConfig = {
  provider: BillingProviderName;
  /** RevenueCat secret API key (v1); empty for mock. Never logged. */
  secretApiKey: string;
  /** The webhook's expected Authorization header value; empty → every webhook call is refused. Never logged. */
  webhookAuth: string;
  entitlementId: string;
  freeAiMessagesPerDay: number;
  freeTripPlacesLimit: number;
};

type Env = Record<string, string | undefined>;

function nonNegativeInt(env: Env, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > max) throw new Error(`${name} must be a whole number between 0 and ${max}`);
  return value;
}

/**
 * The billing settings (docs/app-subscriptions-spec.md). Throws, failing startup, on a mock provider
 * in production, on missing RevenueCat secrets, and on bad numbers. Errors name settings, never values.
 */
export function readBillingConfig(env: Env): BillingConfig {
  const raw = env.BILLING_PROVIDER?.trim().toLowerCase() || 'mock';
  if (!(BILLING_PROVIDERS as readonly string[]).includes(raw)) throw new Error(`BILLING_PROVIDER must be one of ${BILLING_PROVIDERS.join(', ')}`);
  const provider = raw as BillingProviderName;
  if (provider === 'mock' && env.NODE_ENV === 'production') throw new Error('BILLING_PROVIDER=mock is not allowed in production');
  const secretApiKey = env.REVENUECAT_SECRET_API_KEY?.trim() ?? '';
  const webhookAuth = env.REVENUECAT_WEBHOOK_AUTH?.trim() ?? '';
  if (provider === 'revenuecat') {
    const missing = [!secretApiKey && 'REVENUECAT_SECRET_API_KEY', !webhookAuth && 'REVENUECAT_WEBHOOK_AUTH'].filter(Boolean);
    if (missing.length) throw new Error(`BILLING_PROVIDER=revenuecat needs ${missing.join(' and ')}`);
  }
  const freeTripPlacesLimit = nonNegativeInt(env, 'FREE_TRIP_PLACES_LIMIT', 15, MAX_TRIP_PLACES);
  if (freeTripPlacesLimit < 1) throw new Error(`FREE_TRIP_PLACES_LIMIT must be between 1 and ${MAX_TRIP_PLACES}`);
  return {
    provider,
    secretApiKey,
    webhookAuth,
    entitlementId: env.REVENUECAT_ENTITLEMENT_ID?.trim() || 'plus',
    freeAiMessagesPerDay: nonNegativeInt(env, 'FREE_AI_MESSAGES_PER_DAY', 10),
    freeTripPlacesLimit,
  };
}

const BILLING_ENV_KEYS = [
  'NODE_ENV',
  'BILLING_PROVIDER',
  'REVENUECAT_SECRET_API_KEY',
  'REVENUECAT_WEBHOOK_AUTH',
  'REVENUECAT_ENTITLEMENT_ID',
  'FREE_AI_MESSAGES_PER_DAY',
  'FREE_TRIP_PLACES_LIMIT',
];

export const billingConfigFrom = (config: ConfigService): BillingConfig =>
  readBillingConfig(Object.fromEntries(BILLING_ENV_KEYS.map((key) => [key, config.get<string>(key)])));

export const BILLING_CONFIG = Symbol('BILLING_CONFIG');
