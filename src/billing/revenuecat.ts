/** RevenueCat REST v1 (`GET /v1/subscribers/{app_user_id}`) over plain fetch. No SDK. */

export const REVENUECAT_SUBSCRIBERS_URL = 'https://api.revenuecat.com/v1/subscribers';
const TIMEOUT_MS = 10_000;

/** The parts of a v1 subscriber we read. Dates are ISO strings or null. */
export type RevenueCatSubscriber = {
  entitlements?: Record<string, { expires_date?: string | null; grace_period_expires_date?: string | null; product_identifier?: string | null }>;
  subscriptions?: Record<
    string,
    {
      store?: string | null;
      expires_date?: string | null;
      unsubscribe_detected_at?: string | null;
      billing_issues_detected_at?: string | null;
      grace_period_expires_date?: string | null;
    }
  >;
  non_subscriptions?: Record<string, { store?: string | null }[]>;
};

/** Reads a subscriber from the billing backend. `null` = this provider has no remote data (mock). */
export interface BillingProvider {
  readonly name: 'revenuecat' | 'mock';
  /** Throws on any failure (network, timeout, non-2xx); the message never holds secrets. */
  getSubscriber(appUserId: string): Promise<RevenueCatSubscriber | null>;
}

export const BILLING_PROVIDER = Symbol('BILLING_PROVIDER');

type FetchFn = typeof fetch;

export class RevenueCatProvider implements BillingProvider {
  readonly name = 'revenuecat' as const;

  constructor(
    private readonly secretApiKey: string,
    private readonly fetchFn: FetchFn = (...args) => fetch(...args),
  ) {}

  async getSubscriber(appUserId: string): Promise<RevenueCatSubscriber> {
    const response = await this.fetchFn(`${REVENUECAT_SUBSCRIBERS_URL}/${encodeURIComponent(appUserId)}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${this.secretApiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The status only: error bodies may echo the request.
    if (!response.ok) throw new Error(`RevenueCat subscriber lookup failed: HTTP ${response.status}`);
    const body = (await response.json().catch(() => null)) as { subscriber?: RevenueCatSubscriber } | null;
    if (!body?.subscriber || typeof body.subscriber !== 'object') throw new Error('RevenueCat subscriber lookup failed: unexpected body');
    return body.subscriber;
  }
}

/** BILLING_PROVIDER=mock: no remote data; the local table is the whole truth (dev grants, simulated webhooks). */
export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock' as const;

  async getSubscriber(): Promise<null> {
    return null;
  }
}
