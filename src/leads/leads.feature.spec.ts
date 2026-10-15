import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError } from 'typeorm';
import { RateWindow } from '../app-common/rate-window.js';
import type { InMemoryDb } from '../testing/in-memory-db.js';
import { seedUser } from '../testing/app-testing.js';
import { User } from '../users/user.entity.js';
import { Lead } from './lead.entity.js';
import { LeadsService } from './leads.service.js';
import { LeadsTokenService } from './leads-token.service.js';
import { LEADS_ENV, leadsDb, leadsTestingModule, WEB_ORIGIN } from './testing/leads-db.js';

const OK = { kind: 'beta', email: 'Ana@Example.com', name: 'Ana', lang: 'en', source: 'card' };

describe('Public leads (feature)', () => {
  let db: InMemoryDb;
  let app: INestApplication;
  let base: string;
  let service: LeadsService;
  let tokens: LeadsTokenService;
  let infoLogs: string[];

  beforeAll(async () => {
    db = leadsDb();
    const moduleRef = await leadsTestingModule(db).compile();
    service = moduleRef.get(LeadsService);
    tokens = moduleRef.get(LeadsTokenService);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/public/v1`;
  });
  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.all(Lead).forEach((l) => db.repository(Lead as never).delete({ id: l.id }));
    db.all(User).forEach((u) => db.repository(User as never).delete({ id: u.id }));
    jest.restoreAllMocks();
    infoLogs = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void infoLogs.push(String(message)));
    // Fresh per-IP windows and nonce memory for each test.
    Object.assign(service, {
      tokenLimit: new RateWindow(30, 3_600_000, 'x'),
      hourLimit: new RateWindow(5, 3_600_000, 'x'),
      dayLimit: new RateWindow(20, 86_400_000, 'x'),
    });
    tokens.now = Date.now;
  });

  const getToken = async (origin = WEB_ORIGIN) => {
    const res = await fetch(`${base}/leads/token`, { headers: { origin } });
    return ((await res.json()) as { token: string }).token;
  };
  const post = async (body: Record<string, unknown>, headers: Record<string, string> = { origin: WEB_ORIGIN }, withToken = true) => {
    const token = withToken && body.token === undefined ? await getToken(headers.origin ?? WEB_ORIGIN) : body.token;
    return fetch(`${base}/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'jest-agent', ...headers },
      body: JSON.stringify({ ...body, token }),
    });
  };
  const errorOf = async (res: Response) => (await res.json()) as { code: string; reason?: string; fields?: Record<string, string>; message: string };

  describe('GET /leads/token', () => {
    it('returns a token for an allowed origin', async () => {
      const res = await fetch(`${base}/leads/token`, { headers: { origin: WEB_ORIGIN } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ token: expect.stringMatching(/^[\w-]+\.[\w-]+$/), expiresInSeconds: 600 });
    });

    it('accepts the Referer host when there is no Origin', async () => {
      const res = await fetch(`${base}/leads/token`, { headers: { referer: `${WEB_ORIGIN}/en/` } });
      expect(res.status).toBe(200);
    });

    it('refuses other and missing origins with ORIGIN_NOT_ALLOWED', async () => {
      for (const headers of [{ origin: 'https://evil.example' }, {}] as Record<string, string>[]) {
        const res = await fetch(`${base}/leads/token`, { headers });
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toMatchObject({ code: 'FORBIDDEN', reason: 'ORIGIN_NOT_ALLOWED' });
      }
    });

    it('limits 30 tokens per IP per hour, with Retry-After', async () => {
      for (let i = 0; i < 30; i++) expect((await fetch(`${base}/leads/token`, { headers: { origin: WEB_ORIGIN } })).status).toBe(200);
      const res = await fetch(`${base}/leads/token`, { headers: { origin: WEB_ORIGIN } });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await errorOf(res)).code).toBe('RATE_LIMITED');
    });
  });

  describe('POST /leads', () => {
    it('stores the lead: lowercased email, hashed IP, utm, user agent; answers 201 { id, status }', async () => {
      const res = await post({ ...OK, email: '  Ana@Example.COM ', utm: { source: 'newsletter', campaign: 'oct', medium: '' } });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; status: string };
      expect(body).toEqual({ id: expect.any(String), status: 'new' });
      const [row] = db.all(Lead);
      expect(row).toMatchObject({
        id: body.id,
        email: 'ana@example.com',
        name: 'Ana',
        kind: 'beta',
        role: null,
        message: null,
        lang: 'en',
        source: 'card',
        utm: { source: 'newsletter', campaign: 'oct' },
        userAgent: 'jest-agent',
        status: 'new',
        convertedUserId: null,
      });
      expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.ipHash).toBe(createHash('sha256').update(`127.0.0.1${LEADS_ENV.LEADS_HASH_SALT}`).digest('hex'));
      expect(JSON.stringify(row)).not.toContain('127.0.0.1');
    });

    it('keeps a contact message and role', async () => {
      const res = await post({ ...OK, kind: 'contact', role: 'Agency', message: 'Hello there', source: 'coupon' });
      expect(res.status).toBe(201);
      expect(db.all(Lead)[0]).toMatchObject({ kind: 'contact', role: 'Agency', message: 'Hello there', source: 'coupon' });
    });

    it('truncates the user agent to 300 characters', async () => {
      await post(OK, { origin: WEB_ORIGIN, 'user-agent': 'a'.repeat(500) });
      expect(db.all(Lead)[0].userAgent).toHaveLength(300);
    });

    it('checks the origin first, even before reading the body', async () => {
      const res = await fetch(`${base}/leads`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({ code: 'FORBIDDEN', reason: 'ORIGIN_NOT_ALLOWED' });
      expect(db.all(Lead)).toHaveLength(0);
    });

    it('refuses a missing, malformed, reused, expired or foreign-origin token with FORM_TOKEN_INVALID', async () => {
      const bad = async (res: Response) => {
        expect(res.status).toBe(403);
        expect(await errorOf(res)).toMatchObject({ code: 'FORBIDDEN', reason: 'FORM_TOKEN_INVALID' });
      };
      await bad(await post({ ...OK, token: 'nope' }));
      await bad(await fetch(`${base}/leads`, { method: 'POST', headers: { 'content-type': 'application/json', origin: WEB_ORIGIN }, body: JSON.stringify(OK) }));

      const token = await getToken();
      expect((await post({ ...OK, token })).status).toBe(201);
      await bad(await post({ ...OK, email: 'other@example.com', token }));

      const old = await getToken();
      tokens.now = () => Date.now() + 601_000;
      await bad(await post({ ...OK, email: 'late@example.com', token: old }));
      tokens.now = Date.now;

      const foreign = await getToken('https://holidai.pages.dev');
      await bad(await post({ ...OK, email: 'x@example.com', token: foreign }));
      expect(db.all(Lead)).toHaveLength(1);
    });

    it('answers a filled honeypot with a silent 201 and stores nothing (even with invalid fields)', async () => {
      const res = await post({ ...OK, email: 'not-an-email', website: 'http://spam.example' });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual({ id: expect.any(String), status: 'new' });
      expect(db.all(Lead)).toHaveLength(0);
    });

    it('reports validation problems as VALIDATION with fields', async () => {
      const res = await post({
        kind: 'friend',
        email: 'nope',
        name: 'Bad\u0007name',
        message: 'm'.repeat(2001),
        lang: 'fr',
        source: 'Not A Slug',
        role: 'r'.repeat(81),
        utm: { source: 's'.repeat(101) },
      });
      expect(res.status).toBe(400);
      const body = await errorOf(res);
      expect(body.code).toBe('VALIDATION');
      expect(Object.keys(body.fields!).sort()).toEqual(['email', 'kind', 'lang', 'message', 'name', 'role', 'source', 'utm.source']);
      expect(db.all(Lead)).toHaveLength(0);
    });

    it('rejects an empty or 81-character name and unknown fields, and accepts 80', async () => {
      expect((await errorOf(await post({ ...OK, name: '   ' }))).fields).toHaveProperty('name');
      expect((await errorOf(await post({ ...OK, name: 'n'.repeat(81) }))).fields).toHaveProperty('name');
      expect((await errorOf(await post({ ...OK, extra: 1 }))).fields).toHaveProperty('extra');
      expect((await post({ ...OK, name: 'n'.repeat(80) })).status).toBe(201);
    });

    it('409 EMAIL_ALREADY_REGISTERED for a repeated email (any case), without changing the row', async () => {
      expect((await post(OK)).status).toBe(201);
      const res = await post({ ...OK, email: 'ANA@example.com', name: 'Someone else' });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({ code: 'CONFLICT', reason: 'EMAIL_ALREADY_REGISTERED' });
      expect(db.all(Lead)).toHaveLength(1);
      expect(db.all(Lead)[0].name).toBe('Ana');
    });

    it('409 EMAIL_HAS_ACCOUNT when an active user has that email', async () => {
      seedUser(db, 'aaaa1111-0000-4000-8000-000000000000', { email: 'ana@example.com' });
      const res = await post(OK);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toMatchObject({ code: 'CONFLICT', reason: 'EMAIL_HAS_ACCOUNT' });
      expect(db.all(Lead)).toHaveLength(0);
    });

    it('lets a contact message with an existing beta lead update that row (200)', async () => {
      const created = (await (await post(OK)).json()) as { id: string };
      const res = await post({ ...OK, kind: 'contact', message: 'Please call me', role: 'Founder', source: 'coupon' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: created.id, status: 'new' });
      expect(db.all(Lead)).toHaveLength(1);
      expect(db.all(Lead)[0]).toMatchObject({ message: 'Please call me', role: 'Founder', kind: 'beta' });
    });

    it('still answers 409 for a contact without a message, or a beta repeat', async () => {
      await post(OK);
      expect((await post({ ...OK, kind: 'contact' })).status).toBe(409);
      expect((await post({ ...OK, kind: 'beta', message: 'hi' })).status).toBe(409);
    });

    it('maps a unique-index race to EMAIL_ALREADY_REGISTERED', async () => {
      const repo = (service as unknown as { leads: { save: (l: unknown) => Promise<unknown> } }).leads;
      jest.spyOn(repo, 'save').mockRejectedValueOnce(new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: '23505' })));
      const res = await post(OK);
      expect(res.status).toBe(409);
      expect((await errorOf(res)).reason).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('limits 5 leads per IP per hour, then answers 429 with Retry-After', async () => {
      for (let i = 0; i < 5; i++) expect((await post({ ...OK, email: `p${i}@example.com` })).status).toBe(201);
      const res = await post({ ...OK, email: 'p6@example.com' });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await errorOf(res)).code).toBe('RATE_LIMITED');
      expect(db.all(Lead)).toHaveLength(5);
    });

    it('limits 20 leads per IP per day', async () => {
      Object.assign(service, { hourLimit: new RateWindow(1000, 3_600_000, 'x') });
      for (let i = 0; i < 20; i++) expect((await post({ ...OK, email: `d${i}@example.com` })).status).toBe(201);
      const res = await post({ ...OK, email: 'd21@example.com' });
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(3600);
    });

    it('never logs the email at info, and stores nothing in logs but ids', async () => {
      await post({ ...OK, email: 'secret.person@example.com' });
      await post({ ...OK, email: 'secret.person@example.com' });
      await post({ ...OK, email: 'secret.person@example.com', kind: 'contact', message: 'hi' });
      expect(infoLogs.length).toBeGreaterThan(0);
      expect(infoLogs.join('\n')).not.toMatch(/secret\.person|example\.com/);
    });

    it('answers in well under 100 ms', async () => {
      const token = await getToken();
      const start = performance.now();
      await post({ ...OK, token });
      expect(performance.now() - start).toBeLessThan(100);
    });
  });

  describe('CORS', () => {
    const preflight = (path: string, origin: string) =>
      fetch(`${base.replace('/public/v1', '')}${path}`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });

    it('answers the preflight for an allowed origin by echoing it', async () => {
      for (const origin of [WEB_ORIGIN, 'http://localhost:5173']) {
        const res = await preflight('/public/v1/leads', origin);
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        expect(res.headers.get('vary')).toContain('Origin');
        expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
        expect(res.headers.get('access-control-allow-headers')).toBe('Content-Type');
      }
    });

    it('gives no CORS headers to another origin', async () => {
      const res = await preflight('/public/v1/leads', 'https://evil.example');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-methods')).toBeNull();
    });

    it('also tags the real responses (GET token, POST, errors) with the allowed origin', async () => {
      const ok = await fetch(`${base}/leads/token`, { headers: { origin: WEB_ORIGIN } });
      expect(ok.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
      const refused = await fetch(`${base}/leads`, { method: 'POST', headers: { origin: WEB_ORIGIN, 'content-type': 'application/json' }, body: '{}' });
      expect(refused.status).toBe(403);
      expect(refused.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    });

    it('does not touch anything outside /public/v1', async () => {
      const res = await preflight('/app/v1/me', WEB_ORIGIN);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const health = await fetch(`${base.replace('/public/v1', '')}/app/v1/me`, { headers: { origin: WEB_ORIGIN } });
      expect(health.headers.get('access-control-allow-origin')).toBeNull();
    });
  });

  it('is not behind AuthGuard: no Authorization needed, none checked', async () => {
    expect((await post(OK, { origin: WEB_ORIGIN, authorization: 'Bearer garbage' })).status).toBe(201);
  });

  it('keeps the repository token wired (sanity)', () => {
    expect(getRepositoryToken(Lead)).toBeDefined();
  });
});

describe('Public leads without WEB_ORIGINS', () => {
  it('refuses every origin', async () => {
    const moduleRef = await leadsTestingModule(leadsDb(), [], {}).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const res = await fetch(`${await app.getUrl()}/public/v1/leads/token`, { headers: { origin: WEB_ORIGIN } });
      expect(res.status).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('fails startup when WEB_ORIGINS is set without the secrets', async () => {
    await expect(leadsTestingModule(leadsDb(), [], { WEB_ORIGINS: WEB_ORIGIN }).compile()).rejects.toThrow('LEADS_TOKEN_SECRET');
  });
});
