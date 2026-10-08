import type { EntitlementStatus, EntitlementStore, UserEntitlement } from './user-entitlement.entity.js';
import type { RevenueCatSubscriber } from './revenuecat.js';

/** The fields of an entitlement row that events and snapshots decide. */
export type EntitlementState = {
  store: EntitlementStore;
  productId: string | null;
  status: EntitlementStatus;
  expiresAt: Date | null;
  willRenew: boolean | null;
};

/** A RevenueCat webhook event (v1 `event` object), the fields we read. */
export type RevenueCatEvent = {
  id: string;
  type: string;
  app_user_id?: string | null;
  product_id?: string | null;
  new_product_id?: string | null;
  entitlement_ids?: string[] | null;
  entitlement_id?: string | null;
  store?: string | null;
  expiration_at_ms?: number | null;
  grace_period_expiration_at_ms?: number | null;
  transferred_from?: string[] | null;
  transferred_to?: string[] | null;
};

export const ACTIVATING_EVENTS = ['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'];
export const HANDLED_EVENTS = [...ACTIVATING_EVENTS, 'CANCELLATION', 'BILLING_ISSUE', 'EXPIRATION', 'TRANSFER', 'SUBSCRIPTION_PAUSED'];

/** RevenueCat store names (webhook upper-case, REST lower-case) → ours. Stores we don't sell through count as promotional. */
export function toStore(value: string | null | undefined): EntitlementStore {
  switch ((value ?? '').toLowerCase()) {
    case 'app_store':
    case 'mac_app_store':
      return 'app_store';
    case 'play_store':
      return 'play_store';
    default:
      return 'promotional';
  }
}

const date = (ms: number | null | undefined) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms) : null);
const iso = (value: string | null | undefined) => (value ? new Date(value) : null);

/** The later of two expiries, where null means "no end" (later than any date). */
function later(a: Date | null, b: Date | null): Date | null {
  if (a === null || b === null) return null;
  return a.getTime() >= b.getTime() ? a : b;
}

/** Whether the event is about our entitlement (events without entitlement ids are taken as ours). */
export function concernsEntitlement(event: RevenueCatEvent, entitlementId: string): boolean {
  const ids = event.entitlement_ids ?? (event.entitlement_id ? [event.entitlement_id] : null);
  return !ids || ids.includes(entitlementId);
}

/**
 * The entitlement after a (non-TRANSFER) event, or null for "no change". Out-of-order events
 * never move `expiresAt` backwards, and an EXPIRATION of a period older than the one stored is
 * ignored.
 */
export function stateAfterEvent(current: UserEntitlement | null, event: RevenueCatEvent): EntitlementState | null {
  const eventExpiry = date(event.expiration_at_ms);
  const base: EntitlementState = current
    ? { store: current.store, productId: current.productId, status: current.status, expiresAt: current.expiresAt ? new Date(current.expiresAt) : null, willRenew: current.willRenew }
    : { store: toStore(event.store), productId: event.product_id ?? null, status: 'expired', expiresAt: eventExpiry, willRenew: false };
  const store = event.store ? toStore(event.store) : base.store;
  const expiry = current ? later(base.expiresAt, eventExpiry) : eventExpiry;

  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
      return { store, productId: event.product_id ?? base.productId, status: 'active', expiresAt: expiry, willRenew: true };
    case 'PRODUCT_CHANGE':
      return { store, productId: event.new_product_id ?? event.product_id ?? base.productId, status: 'active', expiresAt: expiry, willRenew: true };
    case 'NON_RENEWING_PURCHASE':
      return { store, productId: event.product_id ?? base.productId, status: 'active', expiresAt: expiry, willRenew: false };
    case 'CANCELLATION':
      // Still Plus until it expires.
      return { ...base, store, status: current ? base.status : 'active', expiresAt: expiry, willRenew: false };
    case 'BILLING_ISSUE': {
      const graceEnd = date(event.grace_period_expiration_at_ms) ?? eventExpiry;
      return { ...base, store, status: 'grace', expiresAt: current ? later(base.expiresAt, graceEnd) : graceEnd };
    }
    case 'EXPIRATION':
      if (current && eventExpiry && (base.expiresAt === null || base.expiresAt.getTime() > eventExpiry.getTime())) return null;
      return { ...base, store, status: 'expired', expiresAt: eventExpiry ?? base.expiresAt, willRenew: false };
    default:
      // SUBSCRIPTION_PAUSED (no change until it expires) and anything else.
      return null;
  }
}

/**
 * The entitlement as RevenueCat's REST API reports it (the source of truth), or `undefined` when
 * the subscriber has no such entitlement at all.
 */
export function stateFromSubscriber(subscriber: RevenueCatSubscriber, entitlementId: string, now: Date): EntitlementState | undefined {
  const entitlement = subscriber.entitlements?.[entitlementId];
  if (!entitlement) return undefined;
  const productId = entitlement.product_identifier ?? null;
  const subscription = productId ? subscriber.subscriptions?.[productId] : undefined;
  const store = toStore(subscription?.store ?? (productId ? subscriber.non_subscriptions?.[productId]?.[0]?.store : null));
  const expires = iso(entitlement.expires_date);
  const grace = iso(entitlement.grace_period_expires_date ?? subscription?.grace_period_expires_date);
  const billingIssue = Boolean(subscription?.billing_issues_detected_at);
  const willRenew = subscription ? !subscription.unsubscribe_detected_at : false;

  if (expires === null) return { store, productId, status: 'active', expiresAt: null, willRenew: false };
  if (expires.getTime() > now.getTime()) {
    return { store, productId, status: billingIssue ? 'grace' : 'active', expiresAt: grace ? later(expires, grace) : expires, willRenew };
  }
  if (grace && grace.getTime() > now.getTime()) return { store, productId, status: 'grace', expiresAt: grace, willRenew };
  return { store, productId, status: 'expired', expiresAt: expires, willRenew: false };
}

/** Plus right now: `active` or `grace`, and no expiry or one in the future. */
export function isPlusState(state: Pick<UserEntitlement, 'status' | 'expiresAt'> | null | undefined, now: Date): boolean {
  if (!state || (state.status !== 'active' && state.status !== 'grace')) return false;
  return state.expiresAt === null || new Date(state.expiresAt).getTime() > now.getTime();
}
