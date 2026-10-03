import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { appDb } from '../testing/app-db.js';
import { appTestingModule } from '../testing/app-testing.js';
import type { InMemoryDb } from '../testing/in-memory-db.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from './refresh-token.entity.js';
import { AuthModule } from './auth.module.js';
import { devLoginModule } from './dev-auth.module.js';
import { assertDevLoginAllowed, isDevLoginEnabled } from './dev-login.js';

type Session = {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  user: { id: string; email: string; displayName: string; avatarUrl: string | null; homeCity: string | null; createdAt: string };
};

/** Boots AuthModule plus the conditional dev login with the given env (the way main.ts would see it). */
async function boot(env: { DEV_LOGIN_ENABLED?: string; NODE_ENV?: string }) {
  for (const key of ['DEV_LOGIN_ENABLED', 'NODE_ENV'] as const) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  const db = appDb();
  const moduleRef = await appTestingModule(db, [AuthModule, devLoginModule()]).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, db, url: `${await app.getUrl()}/app/v1` };
}

describe('POST /app/v1/auth/dev (feature, dev only)', () => {
  const saved = { DEV_LOGIN_ENABLED: process.env.DEV_LOGIN_ENABLED, NODE_ENV: process.env.NODE_ENV };
  let app: INestApplication | undefined;
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  afterEach(async () => {
    await app?.close();
    app = undefined;
    warn.mockClear();
  });

  afterAll(() => {
    warn.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const post = (url: string, body: unknown) =>
    fetch(`${url}/auth/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  describe('when disabled', () => {
    it.each([
      ['unset', {}],
      ['false', { DEV_LOGIN_ENABLED: 'false', NODE_ENV: 'development' }],
      ['unset in production', { NODE_ENV: 'production' }],
    ])('is not registered (%s → 404)', async (_label, env) => {
      const booted = await boot(env);
      app = booted.app;

      const res = await post(booted.url, { email: 'ana@example.com' });

      expect(res.status).toBe(404);
      expect(booted.db.all(User)).toEqual([]);
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('DEV_LOGIN_ENABLED'));
    });
  });

  // L2: fails closed. Only NODE_ENV development or test turns it on.
  describe('when enabled outside a dev environment', () => {
    it.each([
      ['NODE_ENV unset', { DEV_LOGIN_ENABLED: 'true' }, 'unset'],
      ['NODE_ENV=staging', { DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'staging' }, '"staging"'],
    ])('is not registered (%s → 404) and warns that it is ignored', async (_label, env, shown) => {
      const booted = await boot(env);
      app = booted.app;

      const res = await post(booted.url, { email: 'ana@example.com' });

      expect(res.status).toBe(404);
      expect(booted.db.all(User)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `DEV_LOGIN_ENABLED=true is ignored: the dev login needs NODE_ENV=development or test (NODE_ENV is ${shown}).`,
      );
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('signs anyone in'));
    });
  });

  it('fails startup when enabled in production', async () => {
    await expect(boot({ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'production' })).rejects.toThrow(
      'DEV_LOGIN_ENABLED=true is not allowed with NODE_ENV=production',
    );
  });

  describe('when enabled', () => {
    let url: string;
    let db: InMemoryDb;

    beforeEach(async () => {
      const booted = await boot({ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'development' });
      ({ app, url, db } = booted);
    });

    it('logs one warning at startup', () => {
      expect(warn.mock.calls.filter(([message]) => String(message).includes('DEV_LOGIN_ENABLED'))).toHaveLength(1);
    });

    it('creates the user on first use and returns an AuthSession like Google sign-in', async () => {
      const res = await post(url, { email: '  Ana.Silva@Example.com ' });

      expect(res.status).toBe(200);
      const session = (await res.json()) as Session;
      expect(session).toEqual({
        accessToken: expect.any(String),
        accessTokenExpiresAt: expect.any(String),
        refreshToken: expect.any(String),
        user: {
          id: expect.any(String),
          email: 'ana.silva@example.com',
          displayName: 'ana.silva',
          avatarUrl: null,
          homeCity: null,
          createdAt: expect.any(String),
        },
      });
      expect(db.all(User)).toEqual([expect.objectContaining({ googleSub: 'dev:ana.silva@example.com' })]);
      expect(db.all(RefreshToken)).toHaveLength(1);
    });

    it('signs the same user in again (matched on the email)', async () => {
      const first = (await (await post(url, { email: 'ana@example.com', displayName: 'Ana' })).json()) as Session;
      const second = (await (await post(url, { email: 'ANA@example.com', displayName: 'Someone else' })).json()) as Session;

      expect(second.user.id).toBe(first.user.id);
      expect(second.user.displayName).toBe('Ana');
      expect(db.all(User)).toHaveLength(1);
      expect(second.refreshToken).not.toBe(first.refreshToken);
    });

    it('issues tokens that work on GET /me and with /auth/refresh', async () => {
      const session = (await (await post(url, { email: 'bob@example.com', displayName: ' Bob ' })).json()) as Session;

      const me = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${session.accessToken}` } });
      const refreshed = await fetch(`${url}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });

      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ id: session.user.id, email: 'bob@example.com', displayName: 'Bob' });
      expect(refreshed.status).toBe(200);
    });

    it.each<[string, unknown, string[]]>([
      ['a missing email', {}, ['email']],
      ['a malformed email', { email: 'ana' }, ['email']],
      ['an empty displayName', { email: 'ana@example.com', displayName: '  ' }, ['displayName']],
      ['a 61-character displayName', { email: 'ana@example.com', displayName: 'x'.repeat(61) }, ['displayName']],
      ['control characters', { email: 'ana@example.com', displayName: 'A\u0000na' }, ['displayName']],
      ['a non-string displayName', { email: 'ana@example.com', displayName: 5 }, ['displayName']],
      ['unknown fields', { email: 'ana@example.com', googleSub: 'x' }, ['googleSub']],
    ])('rejects %s with 400 VALIDATION', async (_label, body, fields) => {
      const res = await post(url, body);

      expect(res.status).toBe(400);
      const error = (await res.json()) as { code: string; fields: Record<string, string> };
      expect(error.code).toBe('VALIDATION');
      expect(Object.keys(error.fields)).toEqual(fields);
      expect(db.all(User)).toEqual([]);
    });

    it('accepts a 60-character displayName', async () => {
      expect((await post(url, { email: 'ana@example.com', displayName: 'x'.repeat(60) })).status).toBe(200);
    });
  });
});

describe('dev login switches', () => {
  it.each([
    [{ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'development' }, true],
    [{ DEV_LOGIN_ENABLED: 'TRUE', NODE_ENV: 'test' }, true],
    // Fails closed: only development and test count as dev environments.
    [{ DEV_LOGIN_ENABLED: 'true' }, false],
    [{ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'staging' }, false],
    [{ DEV_LOGIN_ENABLED: 'true', NODE_ENV: '' }, false],
    [{ DEV_LOGIN_ENABLED: 'false', NODE_ENV: 'development' }, false],
    [{ DEV_LOGIN_ENABLED: '1' }, false],
    [{}, false],
    [{ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'production' }, false],
  ])('isDevLoginEnabled(%j) is %s', (env, enabled) => {
    expect(isDevLoginEnabled(env)).toBe(enabled);
  });

  it('only refuses DEV_LOGIN_ENABLED=true in production', () => {
    expect(() => assertDevLoginAllowed({ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'production' })).toThrow();
    expect(() => assertDevLoginAllowed({ DEV_LOGIN_ENABLED: 'false', NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertDevLoginAllowed({ DEV_LOGIN_ENABLED: 'true', NODE_ENV: 'development' })).not.toThrow();
  });
});
