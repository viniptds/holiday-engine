import { jest } from '@jest/globals';
import { MockBillingProvider, REVENUECAT_SUBSCRIBERS_URL, RevenueCatProvider } from './revenuecat.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('RevenueCatProvider (REST v1, mocked fetch)', () => {
  it('GETs the subscriber with the secret key as a bearer token', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { subscriber: { entitlements: {} } }));
    const provider = new RevenueCatProvider('sk_secret', fetchFn as typeof fetch);

    await expect(provider.getSubscriber('a b/c')).resolves.toEqual({ entitlements: {} });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${REVENUECAT_SUBSCRIBERS_URL}/a%20b%2Fc`);
    expect(init?.method).toBe('GET');
    expect(init?.headers).toEqual({ authorization: 'Bearer sk_secret', accept: 'application/json' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    [json(500, { message: 'echo sk_secret' }), 'HTTP 500'],
    [json(401, {}), 'HTTP 401'],
    [json(200, { nope: true }), 'unexpected body'],
    [new Response('<html>', { status: 200 }), 'unexpected body'],
  ])('fails on a bad answer, without the key in the message (%#)', async (response, message) => {
    const provider = new RevenueCatProvider('sk_secret', (async () => response) as typeof fetch);

    const error = (await provider.getSubscriber('u').catch((e: Error) => e)) as Error;
    expect(error.message).toContain(message);
    expect(error.message).not.toContain('sk_secret');
  });

  it('passes on network errors', async () => {
    const provider = new RevenueCatProvider('sk', (async () => Promise.reject(new Error('fetch failed'))) as typeof fetch);
    await expect(provider.getSubscriber('u')).rejects.toThrow('fetch failed');
  });

  it('mock has no remote data', async () => {
    await expect(new MockBillingProvider().getSubscriber()).resolves.toBeNull();
  });
});
