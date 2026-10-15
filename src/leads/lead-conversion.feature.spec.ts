import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { GoogleTokenVerifier } from '../auth/google-token-verifier.js';
import { TEST_CLIENT_IDS, TestGoogleIssuer } from '../auth/testing/google-id-tokens.js';
import type { InMemoryDb } from '../testing/in-memory-db.js';
import { Lead } from './lead.entity.js';
import { LEADS_ENV, leadsDb, leadsTestingModule } from './testing/leads-db.js';

describe('Lead conversion on Google sign-in (feature)', () => {
  const issuer = new TestGoogleIssuer();
  let db: InMemoryDb;
  let app: INestApplication;
  let base: string;
  let leadRepo: { update: (...args: unknown[]) => Promise<unknown> };

  beforeAll(async () => {
    db = leadsDb();
    const moduleRef = await leadsTestingModule(db, [AuthModule], { ...LEADS_ENV, GOOGLE_CLIENT_IDS: TEST_CLIENT_IDS.join(','), NODE_ENV: 'test' }).compile();
    jest.spyOn(moduleRef.get(GoogleTokenVerifier).client, 'getFederatedSignonCertsAsync').mockResolvedValue({ certs: issuer.certs } as never);
    leadRepo = moduleRef.get(getRepositoryToken(Lead));
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    await app?.close();
  });

  const seedLead = (email: string, status = 'new') =>
    db.seed(Lead, { email, name: 'Ana', kind: 'beta', role: null, message: null, lang: 'en', source: 'card', utm: null, ipHash: 'h'.repeat(64), userAgent: null, status } as never);
  const signIn = (claims: Record<string, unknown>) =>
    fetch(`${base}/app/v1/auth/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: issuer.token(claims) }) });

  it('marks the lead with the same email converted, with the new user id', async () => {
    seedLead('ana@example.com');
    const other = seedLead('bob@example.com');
    const res = await signIn({ sub: 'g-ana', email: 'Ana@Example.com', name: 'Ana' });
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: { id: string } };
    const lead = db.all(Lead).find((l) => l.email === 'ana@example.com')!;
    expect(lead).toMatchObject({ status: 'converted', convertedUserId: user.id });
    expect(db.all(Lead).find((l) => l.id === other.id)).toMatchObject({ status: 'new', convertedUserId: null });
  });

  it('signs in fine when there is no lead', async () => {
    expect((await signIn({ sub: 'g-nolead', email: 'nolead@example.com' })).status).toBe(200);
  });

  it('still signs in when the lead update fails', async () => {
    seedLead('carl@example.com');
    const failing = jest.spyOn(leadRepo, 'update').mockRejectedValue(new Error('db down for carl@example.com'));
    const res = await signIn({ sub: 'g-carl', email: 'carl@example.com' });
    failing.mockRestore();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accessToken: string }).accessToken).toEqual(expect.any(String));
    expect(db.all(Lead).find((l) => l.email === 'carl@example.com')?.status).toBe('new');
  });
});
