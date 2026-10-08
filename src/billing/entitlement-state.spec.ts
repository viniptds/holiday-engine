import { concernsEntitlement, isPlusState, stateAfterEvent, stateFromSubscriber, toStore } from './entitlement-state.js';
import type { RevenueCatEvent } from './entitlement-state.js';
import type { UserEntitlement } from './user-entitlement.entity.js';
import type { RevenueCatSubscriber } from './revenuecat.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const at = (iso: string) => new Date(iso).getTime();
const event = (type: string, fields: Partial<RevenueCatEvent> = {}): RevenueCatEvent => ({
  id: `evt-${type}`,
  type,
  app_user_id: 'u1',
  product_id: 'ai.holid.app.plus.monthly',
  entitlement_ids: ['plus'],
  store: 'APP_STORE',
  expiration_at_ms: at('2026-11-08T12:00:00Z'),
  ...fields,
});
const row = (fields: Partial<UserEntitlement> = {}) =>
  ({
    store: 'app_store',
    productId: 'ai.holid.app.plus.monthly',
    status: 'active',
    expiresAt: new Date('2026-11-08T12:00:00Z'),
    willRenew: true,
    ...fields,
  }) as UserEntitlement;

describe('stateAfterEvent (webhook events)', () => {
  it.each(['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION'])('%s → active, renewing, with the new expiry', (type) => {
    expect(stateAfterEvent(null, event(type))).toEqual({
      store: 'app_store',
      productId: 'ai.holid.app.plus.monthly',
      status: 'active',
      expiresAt: new Date('2026-11-08T12:00:00Z'),
      willRenew: true,
    });
  });

  it('PRODUCT_CHANGE → active on the new product', () => {
    expect(stateAfterEvent(row(), event('PRODUCT_CHANGE', { new_product_id: 'ai.holid.app.plus.yearly' }))).toMatchObject({
      status: 'active',
      productId: 'ai.holid.app.plus.yearly',
    });
  });

  it('NON_RENEWING_PURCHASE → active, not renewing; no expiry means no end', () => {
    expect(stateAfterEvent(null, event('NON_RENEWING_PURCHASE', { expiration_at_ms: null, store: 'PROMOTIONAL' }))).toEqual({
      store: 'promotional',
      productId: 'ai.holid.app.plus.monthly',
      status: 'active',
      expiresAt: null,
      willRenew: false,
    });
  });

  it('CANCELLATION → still active until it expires, willRenew false', () => {
    expect(stateAfterEvent(row(), event('CANCELLATION'))).toMatchObject({ status: 'active', willRenew: false, expiresAt: new Date('2026-11-08T12:00:00Z') });
  });

  it('BILLING_ISSUE → grace until the grace expiry', () => {
    expect(stateAfterEvent(row(), event('BILLING_ISSUE', { grace_period_expiration_at_ms: at('2026-11-24T12:00:00Z') }))).toMatchObject({
      status: 'grace',
      expiresAt: new Date('2026-11-24T12:00:00Z'),
    });
  });

  it('EXPIRATION → expired', () => {
    expect(stateAfterEvent(row(), event('EXPIRATION'))).toMatchObject({ status: 'expired', willRenew: false });
  });

  it('SUBSCRIPTION_PAUSED → no change', () => {
    expect(stateAfterEvent(row(), event('SUBSCRIPTION_PAUSED'))).toBeNull();
  });

  it('never moves the expiry backwards (out-of-order RENEWAL)', () => {
    const later = row({ expiresAt: new Date('2026-12-08T12:00:00Z') });
    expect(stateAfterEvent(later, event('RENEWAL'))!.expiresAt).toEqual(new Date('2026-12-08T12:00:00Z'));
  });

  it('ignores an EXPIRATION of a period older than the stored one', () => {
    expect(stateAfterEvent(row({ expiresAt: new Date('2026-12-08T12:00:00Z') }), event('EXPIRATION'))).toBeNull();
  });

  it('knows which events are about our entitlement', () => {
    expect(concernsEntitlement(event('RENEWAL'), 'plus')).toBe(true);
    expect(concernsEntitlement(event('RENEWAL', { entitlement_ids: ['other'] }), 'plus')).toBe(false);
    expect(concernsEntitlement(event('RENEWAL', { entitlement_ids: null, entitlement_id: null }), 'plus')).toBe(true);
  });

  it('maps stores', () => {
    expect([toStore('APP_STORE'), toStore('mac_app_store'), toStore('PLAY_STORE'), toStore('STRIPE'), toStore(null)]).toEqual([
      'app_store',
      'app_store',
      'play_store',
      'promotional',
      'promotional',
    ]);
  });
});

describe('stateFromSubscriber (REST, the source of truth)', () => {
  const subscriber = (entitlement: Record<string, unknown> | undefined, subscription: Record<string, unknown> = {}): RevenueCatSubscriber => ({
    entitlements: entitlement ? { plus: { product_identifier: 'monthly', ...entitlement } } : {},
    subscriptions: { monthly: { store: 'app_store', unsubscribe_detected_at: null, billing_issues_detected_at: null, ...subscription } },
  });

  it('active, renewing', () => {
    expect(stateFromSubscriber(subscriber({ expires_date: '2026-11-08T12:00:00Z' }), 'plus', NOW)).toEqual({
      store: 'app_store',
      productId: 'monthly',
      status: 'active',
      expiresAt: new Date('2026-11-08T12:00:00Z'),
      willRenew: true,
    });
  });

  it('cancelled (unsubscribe detected) → active, not renewing', () => {
    expect(
      stateFromSubscriber(subscriber({ expires_date: '2026-11-08T12:00:00Z' }, { unsubscribe_detected_at: '2026-10-07T00:00:00Z' }), 'plus', NOW),
    ).toMatchObject({ status: 'active', willRenew: false });
  });

  it('in billing grace → grace until the grace expiry', () => {
    expect(
      stateFromSubscriber(
        subscriber({ expires_date: '2026-10-07T12:00:00Z', grace_period_expires_date: '2026-10-20T12:00:00Z' }, { billing_issues_detected_at: '2026-10-07T12:00:00Z' }),
        'plus',
        NOW,
      ),
    ).toMatchObject({ status: 'grace', expiresAt: new Date('2026-10-20T12:00:00Z') });
  });

  it('lapsed → expired; lifetime → active with no expiry; absent → undefined', () => {
    expect(stateFromSubscriber(subscriber({ expires_date: '2026-10-01T12:00:00Z' }), 'plus', NOW)).toMatchObject({ status: 'expired' });
    expect(stateFromSubscriber(subscriber({ expires_date: null }), 'plus', NOW)).toMatchObject({ status: 'active', expiresAt: null });
    expect(stateFromSubscriber(subscriber(undefined), 'plus', NOW)).toBeUndefined();
  });
});

describe('isPlusState', () => {
  it('is Plus when active or in grace, with no expiry or one in the future', () => {
    expect(isPlusState({ status: 'active', expiresAt: null }, NOW)).toBe(true);
    expect(isPlusState({ status: 'grace', expiresAt: new Date('2026-10-09T00:00:00Z') }, NOW)).toBe(true);
    expect(isPlusState({ status: 'active', expiresAt: new Date('2026-10-08T11:59:59Z') }, NOW)).toBe(false);
    expect(isPlusState({ status: 'expired', expiresAt: null }, NOW)).toBe(false);
    expect(isPlusState(null, NOW)).toBe(false);
  });
});
