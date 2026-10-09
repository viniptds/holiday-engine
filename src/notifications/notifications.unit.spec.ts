import { jest } from '@jest/globals';
import { readNotificationsConfig } from './notifications.config.js';
import { ExpoPushProvider, EXPO_RECEIPTS_URL, EXPO_SEND_URL } from './push/expo-push.js';
import { LogPushProvider } from './push/log-push.js';
import { UnsubscribeTokens } from './unsubscribe-token.js';
import { applyPrefsPatch, effectivePrefs, prefsPatchErrors } from './notification-prefs.js';
import { zonedInstant } from '../app-common/timezone.js';
import { Logger } from '@nestjs/common';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('readNotificationsConfig', () => {
  it('defaults to the log provider, 09:00 and localhost', () => {
    expect(readNotificationsConfig({})).toEqual({ pushProvider: 'log', expoAccessToken: undefined, sendHour: 9, publicUrl: 'http://localhost:3000' });
    expect(readNotificationsConfig({ PORT: '3001', ENGINE_PUBLIC_URL: 'https://api.holid.ai/' }).publicUrl).toBe('https://api.holid.ai');
  });

  it('refuses the log provider in production, like the other mocks', () => {
    expect(() => readNotificationsConfig({ NODE_ENV: 'production', ENGINE_PUBLIC_URL: 'https://api.holid.ai' })).toThrow('PUSH_PROVIDER=log is not allowed in production');
    expect(readNotificationsConfig({ NODE_ENV: 'production', PUSH_PROVIDER: 'expo', ENGINE_PUBLIC_URL: 'https://api.holid.ai' }).pushProvider).toBe('expo');
    expect(() => readNotificationsConfig({ NODE_ENV: 'production', PUSH_PROVIDER: 'expo' })).toThrow('ENGINE_PUBLIC_URL is required in production');
  });

  it.each([
    [{ PUSH_PROVIDER: 'fcm' }, 'Unknown PUSH_PROVIDER "fcm"'],
    [{ NOTIFICATIONS_SEND_HOUR: '24' }, 'NOTIFICATIONS_SEND_HOUR must be a whole hour from 0 to 23 (got "24")'],
    [{ NOTIFICATIONS_SEND_HOUR: '9.5' }, 'NOTIFICATIONS_SEND_HOUR'],
    [{ ENGINE_PUBLIC_URL: 'api.holid.ai' }, 'ENGINE_PUBLIC_URL must be an http(s) URL'],
  ])('fails on %j', (env, message) => {
    expect(() => readNotificationsConfig(env)).toThrow(message);
  });
});

describe('ExpoPushProvider', () => {
  it('sends in batches of 100 with the access token, and maps tickets', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as { to: string }[];
      return json({ data: batch.map((m, i) => (m.to.endsWith('[dead]') ? { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `t${i}` })) });
    });
    const provider = new ExpoPushProvider('expo-access', fetchFn as typeof fetch);
    const messages = Array.from({ length: 150 }, (_, i) => ({ to: i === 120 ? 'ExponentPushToken[dead]' : `ExponentPushToken[${i}]`, title: 'T', body: 'B', data: { route: '/x' } }));

    const results = await provider.send(messages);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(EXPO_SEND_URL);
    expect(init?.headers).toMatchObject({ authorization: 'Bearer expo-access', 'content-type': 'application/json', accept: 'application/json' });
    expect(JSON.parse(String(init?.body))).toHaveLength(100);
    expect(JSON.parse(String(init?.body))[0]).toEqual({ to: 'ExponentPushToken[0]', title: 'T', body: 'B', data: { route: '/x' }, sound: 'default', priority: 'high' });
    expect(results[0]).toEqual({ token: 'ExponentPushToken[0]', ticketId: 't0' });
    expect(results[120]).toEqual({ token: 'ExponentPushToken[dead]', error: 'DeviceNotRegistered' });
  });

  it('sends no Authorization without an access token, reads receipts, and fails with the status only', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ data: { a: { status: 'ok' }, b: { status: 'error', details: { error: 'DeviceNotRegistered' } } } }));
    const provider = new ExpoPushProvider(undefined, fetchFn as typeof fetch);

    const receipts = await provider.receipts(['a', 'b']);
    expect(fetchFn.mock.calls[0][0]).toBe(EXPO_RECEIPTS_URL);
    expect(fetchFn.mock.calls[0][1]?.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body))).toEqual({ ids: ['a', 'b'] });
    expect(receipts.get('b')).toEqual({ status: 'error', error: 'DeviceNotRegistered' });

    const failing = new ExpoPushProvider('k', (async () => json({ errors: ['ExponentPushToken[secret]'] }, 500)) as typeof fetch);
    await expect(failing.send([{ to: 'ExponentPushToken[secret]', title: '', body: '', data: {} }])).rejects.toThrow(/^Expo push failed: HTTP 500$/);
  });
});

describe('LogPushProvider', () => {
  it('logs the type and recipient count, never tokens', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    await new LogPushProvider().send([{ to: 'ExponentPushToken[abc]', title: 't', body: 'b', data: { type: 'countdown' } }]);
    expect(log).toHaveBeenCalledWith('Not sent (PUSH_PROVIDER=log): countdown to 1 device(s)');
    expect(JSON.stringify(log.mock.calls)).not.toContain('abc');
    log.mockRestore();
  });
});

describe('UnsubscribeTokens', () => {
  const tokens = new UnsubscribeTokens('a-jwt-secret-that-is-long-enough-0000000');
  const USER = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';

  it('round-trips and refuses forgeries', () => {
    const token = tokens.sign(USER);
    expect(tokens.verify(token)).toBe(USER);
    expect(new UnsubscribeTokens('another-secret-entirely-00000000000000').verify(token)).toBeNull();
    const [, signature] = token.split('.');
    expect(tokens.verify(`${Buffer.from('22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f').toString('base64url')}.${signature}`)).toBeNull();
    expect(tokens.verify('junk')).toBeNull();
    expect(tokens.verify('')).toBeNull();
  });
});

describe('notification prefs', () => {
  it('fills missing switches with on, and patches partially', () => {
    expect(effectivePrefs({ push: { invites: false } })).toEqual({
      push: { countdown: true, checklist: true, tripActivity: true, achievements: true, invites: false },
      email: { countdown: true },
    });
    expect(applyPrefsPatch(effectivePrefs(null), { email: { countdown: false } }).email.countdown).toBe(false);
    expect(prefsPatchErrors({ push: { invites: 1 }, extra: true })).toEqual({ 'push.invites': 'must be true or false', extra: 'unknown setting' });
  });
});

describe('zonedInstant', () => {
  it.each([
    ['America/Sao_Paulo', '2026-10-11', 9, '2026-10-11T12:00:00.000Z'],
    ['Asia/Tokyo', '2026-10-11', 9, '2026-10-11T00:00:00.000Z'],
    ['Europe/Madrid', '2026-03-29', 9, '2026-03-29T07:00:00.000Z'],
    ['Europe/Madrid', '2026-03-28', 9, '2026-03-28T08:00:00.000Z'],
    ['Pacific/Auckland', '2026-09-27', 9, '2026-09-26T20:00:00.000Z'],
    ['UTC', '2026-01-01', 0, '2026-01-01T00:00:00.000Z'],
  ])('%s %s %i:00 → %s', (zone, date, hour, expected) => {
    expect(zonedInstant(zone, date, hour).toISOString()).toBe(expected);
  });
});
