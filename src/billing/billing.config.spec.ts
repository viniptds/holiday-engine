import { readBillingConfig } from './billing.config.js';

describe('readBillingConfig', () => {
  it('defaults to the mock provider and the spec limits', () => {
    expect(readBillingConfig({})).toEqual({
      provider: 'mock',
      secretApiKey: '',
      webhookAuth: '',
      entitlementId: 'plus',
      freeAiMessagesPerDay: 10,
      freeTripPlacesLimit: 15,
    });
  });

  it('reads the settings', () => {
    expect(
      readBillingConfig({
        BILLING_PROVIDER: 'RevenueCat',
        REVENUECAT_SECRET_API_KEY: 'sk_x',
        REVENUECAT_WEBHOOK_AUTH: 'whsec',
        REVENUECAT_ENTITLEMENT_ID: 'pro',
        FREE_AI_MESSAGES_PER_DAY: '3',
        FREE_TRIP_PLACES_LIMIT: '20',
        NODE_ENV: 'production',
      }),
    ).toMatchObject({ provider: 'revenuecat', entitlementId: 'pro', freeAiMessagesPerDay: 3, freeTripPlacesLimit: 20 });
  });

  it('fails startup with mock in production, and names (never shows) missing RevenueCat secrets', () => {
    expect(() => readBillingConfig({ NODE_ENV: 'production' })).toThrow('BILLING_PROVIDER=mock is not allowed in production');
    expect(() => readBillingConfig({ BILLING_PROVIDER: 'revenuecat' })).toThrow(
      'BILLING_PROVIDER=revenuecat needs REVENUECAT_SECRET_API_KEY and REVENUECAT_WEBHOOK_AUTH',
    );
    expect(() => readBillingConfig({ BILLING_PROVIDER: 'revenuecat', REVENUECAT_SECRET_API_KEY: 'sk_secret' })).toThrow(
      /needs REVENUECAT_WEBHOOK_AUTH$/,
    );
  });

  it.each([
    [{ BILLING_PROVIDER: 'stripe' }, 'BILLING_PROVIDER must be one of'],
    [{ FREE_AI_MESSAGES_PER_DAY: '-1' }, 'FREE_AI_MESSAGES_PER_DAY'],
    [{ FREE_AI_MESSAGES_PER_DAY: '2.5' }, 'FREE_AI_MESSAGES_PER_DAY'],
    [{ FREE_TRIP_PLACES_LIMIT: '0' }, 'FREE_TRIP_PLACES_LIMIT'],
    [{ FREE_TRIP_PLACES_LIMIT: '201' }, 'FREE_TRIP_PLACES_LIMIT'],
  ])('rejects %j', (env, message) => {
    expect(() => readBillingConfig(env)).toThrow(message);
  });
});
