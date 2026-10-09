import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Controller, Get, Inject, INestApplication, Module, UseFilters, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator, QueryFailedError } from 'typeorm';
import { APP_PREFIX, USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { User } from '../users/user.entity.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { AuthModule } from './auth.module.js';
import { AuthGuard } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import { GoogleTokenVerifier } from './google-token-verifier.js';
import { RefreshToken } from './refresh-token.entity.js';
import { hashRefreshToken } from './refresh-token.service.js';
import { TEST_CLIENT_IDS, TestGoogleIssuer } from './testing/google-id-tokens.js';
import type { GoogleClaims } from './testing/google-id-tokens.js';

type Row = { id: string } & Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (!(expected instanceof FindOperator)) return row[key] === expected;
    if (expected.type === 'isNull') return row[key] == null;
    if (expected.type === 'in') return (expected.value as unknown[]).includes(row[key]);
    throw new Error(`Unsupported operator ${expected.type}`);
  });
}

/**
 * In-memory stand-in for a TypeORM repository: just the calls the users and auth services make.
 * Soft-deleted rows are hidden from finds, like `@DeleteDateColumn` does; `unique` mimics the indexes.
 */
class InMemoryRepository<T extends object> {
  readonly rows = new Map<string, Row>();

  constructor(private readonly options: { softDelete?: boolean; conflicts?: (a: Row, b: Row) => boolean }) {}

  /** Transactions run straight through (no rollback or locks): the lock behaviour is covered over InMemoryDb. */
  readonly manager = {
    transaction: async <R>(work: (manager: unknown) => Promise<R>): Promise<R> =>
      work({
        findOne: (_entity: unknown, options: { where: Record<string, unknown> }) => this.findOne(options),
        update: (_entity: unknown, where: Record<string, unknown>, changes: Partial<T>) => this.update(where, changes),
        getRepository: () => this,
      }),
  };

  all(): T[] {
    return [...this.rows.values()].map((row) => ({ ...row }) as T);
  }

  create(data: Partial<T>): T {
    return { ...data } as T;
  }

  async save(entity: T): Promise<T> {
    const now = new Date();
    const row = { ...entity } as unknown as Row;
    if (!row.id) Object.assign(row, { id: randomUUID(), createdAt: now, ...(this.options.softDelete && { deletedAt: null }) });
    if (this.options.softDelete) row.updatedAt = now;
    for (const other of this.rows.values()) {
      if (other.id !== row.id && this.options.conflicts?.(row, other)) {
        throw new QueryFailedError('INSERT', [], Object.assign(new Error('duplicate key'), { code: '23505' }));
      }
    }
    this.rows.set(row.id, { ...row });
    return Object.assign(entity, row);
  }

  async findOne({ where }: { where: Record<string, unknown> }): Promise<T | null> {
    return (await this.find({ where }))[0] ?? null;
  }

  async find({ where }: { where: Record<string, unknown> }): Promise<T[]> {
    return [...this.rows.values()]
      .filter((row) => !(this.options.softDelete && row.deletedAt) && matches(row, where))
      .map((row) => ({ ...row }) as T);
  }

  async update(where: Record<string, unknown>, changes: Partial<T>): Promise<{ affected: number }> {
    const hits = [...this.rows.values()].filter((row) => matches(row, where));
    hits.forEach((row) => Object.assign(row, changes));
    return { affected: hits.length };
  }

  async softDelete(where: Record<string, unknown>): Promise<{ affected: number }> {
    return this.update({ ...where, deletedAt: null }, { deletedAt: new Date() } as unknown as Partial<T>);
  }
}

/** What another feature module (Agent 2's) would do: import AuthModule and use its guard and directory. */
@Controller(`${APP_PREFIX}/probe`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
class ProbeController {
  constructor(@Inject(USER_DIRECTORY) private readonly directory: UserDirectory) {}

  @Get()
  whoAmI(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('profile')
  async profile(@CurrentUser() user: AuthUser) {
    return (await this.directory.getProfiles([user.id])).get(user.id);
  }
}

@Module({ imports: [AuthModule], controllers: [ProbeController] })
class ProbeModule {}

const env: Record<string, string> = { GOOGLE_CLIENT_IDS: TEST_CLIENT_IDS.join(','), NODE_ENV: 'test' };

const userRepository = () =>
  new InMemoryRepository<User>({
    softDelete: true,
    conflicts: (a, b) => a.googleSub === b.googleSub && !a.deletedAt && !b.deletedAt,
  });
const tokenRepository = () => new InMemoryRepository<RefreshToken>({ conflicts: (a, b) => a.tokenHash === b.tokenHash });

/**
 * Feature tests for the app API auth and profile endpoints (`docs/app-api-contract.md`): the real Nest
 * HTTP stack and AuthModule over a real port, with in-memory repositories and Google's cert endpoint
 * replaced by a local key (google-auth-library still checks signature, audience, issuer and expiry).
 */
describe('App auth and profile (feature)', () => {
  const issuer = new TestGoogleIssuer();
  const users = userRepository();
  const tokens = tokenRepository();
  const onDelete = jest.fn(async (_userId: string) => undefined);
  let app: INestApplication;
  let baseUrl: string;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule, ProbeModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => env[key] })
      .overrideProvider(getRepositoryToken(User))
      .useValue(users)
      .overrideProvider(getRepositoryToken(RefreshToken))
      .useValue(tokens)
      .compile();

    jest
      .spyOn(moduleRef.get(GoogleTokenVerifier).client, 'getFederatedSignonCertsAsync')
      .mockResolvedValue({ certs: issuer.certs } as never);
    moduleRef.get(UserDeletionHooks).register((userId) => onDelete(userId));
    jwt = moduleRef.get(JwtService);

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    users.rows.clear();
    tokens.rows.clear();
    onDelete.mockReset();
    onDelete.mockResolvedValue(undefined);
  });

  const call = (method: string, path: string, options: { body?: unknown; token?: string; authorization?: string } = {}) => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.authorization) headers.authorization = options.authorization;
    return fetch(`${baseUrl}/${APP_PREFIX}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  };

  /** Every error must be exactly `{ code, message, fields? }` with the contract's status. */
  async function expectError(res: Response, status: number, code: string, fields?: Record<string, unknown>) {
    expect(res.status).toBe(status);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(fields ? ['code', 'fields', 'message'] : ['code', 'message']);
    expect(body).toMatchObject({ code, message: expect.any(String) });
    if (fields) expect(body.fields).toEqual(fields);
    return body;
  }

  type Session = {
    accessToken: string;
    accessTokenExpiresAt: string;
    refreshToken: string;
    user: { id: string; email: string; displayName: string; avatarUrl: string | null; homeCity: string | null; createdAt: string };
  };

  async function signIn(claims: GoogleClaims = {}): Promise<Session> {
    const res = await call('POST', '/auth/google', { body: { idToken: issuer.token(claims) } });
    expect(res.status).toBe(200);
    return (await res.json()) as Session;
  }

  const refresh = (refreshToken: string) => call('POST', '/auth/refresh', { body: { refreshToken } });
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  describe('POST /auth/google', () => {
    it('creates the user on first sign-in and returns an AuthSession', async () => {
      const before = Date.now();
      const session = await signIn();

      expect(Object.keys(session).sort()).toEqual(['accessToken', 'accessTokenExpiresAt', 'refreshToken', 'user']);
      expect(session.user).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: 'ana@example.com',
        displayName: 'Ana Silva',
        avatarUrl: 'https://lh3.googleusercontent.com/a/ana',
        avatarSource: 'google',
        hasGooglePicture: true,
        homeCity: null,
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      });
      expect(users.all()).toHaveLength(1);
      expect(users.all()[0]).toMatchObject({ googleSub: '109876543210987654321' });

      const claims = jwt.decode<{ sub: string; iat: number; exp: number }>(session.accessToken);
      expect(claims.sub).toBe(session.user.id);
      expect(claims.exp - claims.iat).toBe(15 * 60);
      expect(new Date(session.accessTokenExpiresAt).getTime()).toBe(claims.exp * 1000);
      expect(new Date(session.accessTokenExpiresAt).getTime()).toBeGreaterThanOrEqual(before + 15 * 60 * 1000 - 1000);
      expect(JSON.parse(Buffer.from(session.accessToken.split('.')[0], 'base64url').toString())).toMatchObject({ alg: 'HS256' });

      expect(session.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const [stored] = tokens.all();
      expect(stored).toMatchObject({ userId: session.user.id, tokenHash: hashRefreshToken(session.refreshToken), revokedAt: null });
      expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
      const days = (stored.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.99);
      expect(days).toBeLessThanOrEqual(30);
    });

    it('finds the same user on the second sign-in', async () => {
      const first = await signIn();
      const second = await signIn();

      expect(second.user.id).toBe(first.user.id);
      expect(second.refreshToken).not.toBe(first.refreshToken);
      expect(users.all()).toHaveLength(1);
    });

    it('accepts the iOS and Android client ids as audience', async () => {
      await signIn({ aud: TEST_CLIENT_IDS[1] });
      await signIn({ aud: TEST_CLIENT_IDS[2] });

      expect(users.all()).toHaveLength(1);
    });

    it.each([
      ['a wrong audience', () => issuer.token({ aud: 'other-app.apps.googleusercontent.com' })],
      ['an expired token', () => issuer.token({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 })],
      ['a wrong issuer', () => issuer.token({ iss: 'https://evil.example.com' })],
      ['a forged signature', () => issuer.forgedToken()],
      ['an unverified email', () => issuer.token({ email_verified: false })],
      ['garbage', () => 'abc.def.ghi'],
    ])('rejects %s with 401 UNAUTHENTICATED and creates nothing', async (_label, idToken) => {
      const res = await call('POST', '/auth/google', { body: { idToken: idToken() } });

      await expectError(res, 401, 'UNAUTHENTICATED');
      expect(users.all()).toHaveLength(0);
      expect(tokens.all()).toHaveLength(0);
    });

    it('rejects a missing idToken with 400 VALIDATION and fields', async () => {
      await expectError(await call('POST', '/auth/google', { body: {} }), 400, 'VALIDATION', {
        idToken: expect.any(String),
      });
    });

    it('rejects unknown fields with 400 VALIDATION', async () => {
      const res = await call('POST', '/auth/google', { body: { idToken: issuer.token(), admin: true } });

      await expectError(res, 400, 'VALIDATION', { admin: expect.any(String) });
    });

    it('creates a new user when a deleted account signs in again', async () => {
      const first = await signIn();
      expect((await call('DELETE', '/me', { token: first.accessToken })).status).toBe(204);

      const again = await signIn();

      expect(again.user.id).not.toBe(first.user.id);
      expect(users.all()).toHaveLength(2);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rotates: returns a new session and revokes the old token', async () => {
      const session = await signIn();

      const res = await refresh(session.refreshToken);

      expect(res.status).toBe(200);
      const next = (await res.json()) as Session;
      expect(next.user).toEqual(session.user);
      expect(next.refreshToken).not.toBe(session.refreshToken);
      expect(jwt.decode<{ sub: string }>(next.accessToken).sub).toBe(session.user.id);
      const old = tokens.all().find((t) => t.tokenHash === hashRefreshToken(session.refreshToken))!;
      const replacement = tokens.all().find((t) => t.tokenHash === hashRefreshToken(next.refreshToken))!;
      expect(old.revokedAt).toBeInstanceOf(Date);
      expect(old.replacedById).toBe(replacement.id);
      expect(replacement.revokedAt).toBeNull();
    });

    it('detects reuse of a revoked token: 401 and every token of the user is revoked', async () => {
      const session = await signIn();
      const otherDevice = await signIn();
      const next = (await (await refresh(session.refreshToken)).json()) as Session;

      await expectError(await refresh(session.refreshToken), 401, 'UNAUTHENTICATED');

      expect(tokens.all().every((t) => t.revokedAt instanceof Date)).toBe(true);
      await expectError(await refresh(next.refreshToken), 401, 'UNAUTHENTICATED');
      await expectError(await refresh(otherDevice.refreshToken), 401, 'UNAUTHENTICATED');
    });

    it('does not touch other users on reuse', async () => {
      const ana = await signIn();
      const bo = await signIn({ sub: 'bo-sub', email: 'bo@example.com' });
      await refresh(ana.refreshToken);

      await refresh(ana.refreshToken);

      expect((await refresh(bo.refreshToken)).status).toBe(200);
    });

    it('rejects an expired token with 401', async () => {
      const session = await signIn();
      const [stored] = tokens.all();
      tokens.rows.get(stored.id)!.expiresAt = new Date(Date.now() - 1000);

      await expectError(await refresh(session.refreshToken), 401, 'UNAUTHENTICATED');
    });

    it('rejects an unknown token with 401', async () => {
      await expectError(await refresh('x'.repeat(43)), 401, 'UNAUTHENTICATED');
    });

    it('rejects a missing refreshToken with 400 VALIDATION', async () => {
      await expectError(await call('POST', '/auth/refresh', { body: {} }), 400, 'VALIDATION', {
        refreshToken: expect.any(String),
      });
    });
  });

  describe('POST /auth/logout', () => {
    it('revokes the refresh token and returns 204 without an access token', async () => {
      const session = await signIn();

      const res = await call('POST', '/auth/logout', { body: { refreshToken: session.refreshToken } });

      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(tokens.all()[0].revokedAt).toBeInstanceOf(Date);
      await expectError(await refresh(session.refreshToken), 401, 'UNAUTHENTICATED');
    });

    it('only revokes that token: other sessions keep working', async () => {
      const phone = await signIn();
      const tablet = await signIn();

      await call('POST', '/auth/logout', { body: { refreshToken: phone.refreshToken } });

      expect((await refresh(tablet.refreshToken)).status).toBe(200);
    });

    it('returns 204 for an unknown token', async () => {
      expect((await call('POST', '/auth/logout', { body: { refreshToken: 'unknown' } })).status).toBe(204);
    });

    it('rejects a missing refreshToken with 400 VALIDATION', async () => {
      await expectError(await call('POST', '/auth/logout', { body: {} }), 400, 'VALIDATION', {
        refreshToken: expect.any(String),
      });
    });
  });

  describe('AuthGuard (from another module) and @CurrentUser()', () => {
    it('lets a valid access token through and provides the AuthUser', async () => {
      const session = await signIn();

      const res = await call('GET', '/probe', { token: session.accessToken });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: session.user.id, email: 'ana@example.com', devAccount: false, timezone: null, locale: null });
    });

    it('exposes USER_DIRECTORY to modules importing AuthModule', async () => {
      const session = await signIn();

      const res = await call('GET', '/probe/profile', { token: session.accessToken });

      expect(await res.json()).toEqual({
        id: session.user.id,
        displayName: 'Ana Silva',
        avatarUrl: 'https://lh3.googleusercontent.com/a/ana',
      });
    });

    const noneAlg = (sub: string) =>
      `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
        JSON.stringify({ sub, iat: nowSeconds(), exp: nowSeconds() + 900 }),
      ).toString('base64url')}.`;

    it.each([
      ['a missing token', () => ({})],
      ['a non-Bearer scheme', (s: Session) => ({ authorization: `Basic ${s.accessToken}` })],
      ['an invalid token', () => ({ token: 'not.a.jwt' })],
      ['a token signed with another secret', (s: Session) => ({ token: new JwtService({ secret: 'y'.repeat(40) }).sign({ sub: s.user.id }) })],
      ['an alg=none token', (s: Session) => ({ token: noneAlg(s.user.id) })],
      ['an expired token', (s: Session) => ({ token: jwt.sign({ sub: s.user.id, iat: nowSeconds() - 1800, exp: nowSeconds() - 900 }) })],
      ['a token for an unknown user', () => ({ token: jwt.sign({ sub: randomUUID() }) })],
      ['a token with a non-uuid sub', () => ({ token: jwt.sign({ sub: 'admin' }) })],
      ['a refresh token', (s: Session) => ({ token: s.refreshToken })],
    ])('rejects %s with 401 UNAUTHENTICATED', async (_label, auth) => {
      const session = await signIn();
      const options = auth(session);

      await expectError(await call('GET', '/probe', options), 401, 'UNAUTHENTICATED');
      await expectError(await call('GET', '/me', options), 401, 'UNAUTHENTICATED');
    });

    it('rejects a still-valid access token of a deleted user', async () => {
      const session = await signIn();
      await users.softDelete({ id: session.user.id });

      await expectError(await call('GET', '/probe', { token: session.accessToken }), 401, 'UNAUTHENTICATED');
    });
  });

  describe('GET /me', () => {
    it('returns the User', async () => {
      const session = await signIn();

      const res = await call('GET', '/me', { token: session.accessToken });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(session.user);
    });
  });

  describe('PATCH /me', () => {
    it('updates displayName and homeCity (trimmed) and returns the User', async () => {
      const session = await signIn();

      const res = await call('PATCH', '/me', { token: session.accessToken, body: { displayName: '  Ana S. ', homeCity: ' Porto ' } });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ...session.user, displayName: 'Ana S.', homeCity: 'Porto' });
      expect(await (await call('GET', '/me', { token: session.accessToken })).json()).toMatchObject({ homeCity: 'Porto' });
    });

    it('clears homeCity with null and leaves omitted fields unchanged', async () => {
      const session = await signIn();
      await call('PATCH', '/me', { token: session.accessToken, body: { homeCity: 'Porto' } });

      const res = await call('PATCH', '/me', { token: session.accessToken, body: { homeCity: null } });

      expect(await res.json()).toMatchObject({ displayName: 'Ana Silva', homeCity: null });
    });

    it('keeps an edited displayName on the next Google sign-in', async () => {
      const session = await signIn();
      await call('PATCH', '/me', { token: session.accessToken, body: { displayName: 'Ana S.' } });

      expect((await signIn()).user.displayName).toBe('Ana S.');
    });

    it.each([
      ['a null displayName', { displayName: null }, 'displayName'],
      ['an empty displayName', { displayName: '   ' }, 'displayName'],
      ['a displayName over 100 characters', { displayName: 'x'.repeat(101) }, 'displayName'],
      ['a non-string displayName', { displayName: 42 }, 'displayName'],
      ['a control character in homeCity', { homeCity: 'Por\u0000to' }, 'homeCity'],
      ['a homeCity over 100 characters', { homeCity: 'x'.repeat(101) }, 'homeCity'],
      ['an unknown field', { email: 'mallory@example.com' }, 'email'],
    ])('rejects %s with 400 VALIDATION and fields', async (_label, body, field) => {
      const session = await signIn();

      await expectError(await call('PATCH', '/me', { token: session.accessToken, body }), 400, 'VALIDATION', {
        [field]: expect.any(String),
      });
      expect(users.all()[0]).toMatchObject({ email: 'ana@example.com', displayName: 'Ana Silva' });
    });

    it('requires an access token', async () => {
      await expectError(await call('PATCH', '/me', { body: { displayName: 'X' } }), 401, 'UNAUTHENTICATED');
    });
  });

  describe('DELETE /me', () => {
    it('runs the deletion hooks, revokes every refresh token and soft-deletes the user', async () => {
      const session = await signIn();
      const otherDevice = await signIn();
      onDelete.mockImplementationOnce(async (userId) => {
        // Hooks run before the user is deleted, so they can still read the account.
        expect(users.all()[0].deletedAt).toBeNull();
        expect(userId).toBe(session.user.id);
      });

      const res = await call('DELETE', '/me', { token: session.accessToken });

      expect(res.status).toBe(204);
      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(users.all()[0].deletedAt).toBeInstanceOf(Date);
      expect(tokens.all().every((t) => t.revokedAt instanceof Date)).toBe(true);
      await expectError(await call('GET', '/me', { token: session.accessToken }), 401, 'UNAUTHENTICATED');
      await expectError(await refresh(otherDevice.refreshToken), 401, 'UNAUTHENTICATED');
    });

    it('leaves the account intact when a hook fails, with a generic 500', async () => {
      const session = await signIn();
      onDelete.mockRejectedValueOnce(new Error('trip cleanup failed: secret detail'));

      const res = await call('DELETE', '/me', { token: session.accessToken });

      const body = await expectError(res, 500, 'INTERNAL');
      expect(body.message).toBe('Something went wrong');
      expect(users.all()[0].deletedAt).toBeNull();
      expect(tokens.all()[0].revokedAt).toBeNull();
      expect((await call('GET', '/me', { token: session.accessToken })).status).toBe(200);
    });

    it('requires an access token', async () => {
      await expectError(await call('DELETE', '/me'), 401, 'UNAUTHENTICATED');
      expect(onDelete).not.toHaveBeenCalled();
    });
  });
});

describe('AuthModule startup', () => {
  async function compileWith(values: Record<string, string>) {
    return Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => values[key] })
      .overrideProvider(getRepositoryToken(User))
      .useValue(userRepository())
      .overrideProvider(getRepositoryToken(RefreshToken))
      .useValue(tokenRepository())
      .compile();
  }

  it.each([
    ['missing', {}],
    ['shorter than 32 characters', { JWT_SECRET: 'x'.repeat(31) }],
  ])('fails when JWT_SECRET is %s outside NODE_ENV=test', async (_label, values) => {
    await expect(compileWith({ NODE_ENV: 'production', ...values })).rejects.toThrow(/JWT_SECRET/);
  });

  it('starts with a 32-character JWT_SECRET', async () => {
    const moduleRef = await compileWith({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) });

    expect(moduleRef.get(JwtService)).toBeDefined();
    await moduleRef.close();
  });
});
