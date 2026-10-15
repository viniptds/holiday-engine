import { LeadsTokenService, TOKEN_TTL_SECONDS } from './leads-token.service.js';
import { readLeadsConfig } from './leads.config.js';

const config = readLeadsConfig({ WEB_ORIGINS: 'https://holid.ai', LEADS_TOKEN_SECRET: 'x'.repeat(32), LEADS_HASH_SALT: 'y'.repeat(16) });
const ORIGIN = 'https://holid.ai';

describe('LeadsTokenService', () => {
  let service: LeadsTokenService;
  let now: number;
  beforeEach(() => {
    now = Date.UTC(2026, 9, 15, 12);
    service = new LeadsTokenService(config);
    service.now = () => now;
  });

  it('issues base64url(payload).base64url(hmac) valid for 10 minutes', () => {
    const { token, expiresInSeconds } = service.issue(ORIGIN);
    expect(expiresInSeconds).toBe(600);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(Buffer.from(payload.nonce, 'base64url')).toHaveLength(16);
    expect(payload).toMatchObject({ iat: now, origin: ORIGIN });
    expect(service.redeem(token, ORIGIN)).toBe(true);
  });

  it('is single use', () => {
    const { token } = service.issue(ORIGIN);
    expect(service.redeem(token, ORIGIN)).toBe(true);
    expect(service.redeem(token, ORIGIN)).toBe(false);
  });

  it('expires after 10 minutes but not before', () => {
    const { token } = service.issue(ORIGIN);
    now += TOKEN_TTL_SECONDS * 1000;
    expect(service.redeem(token, ORIGIN)).toBe(true);
    const late = service.issue(ORIGIN).token;
    now += TOKEN_TTL_SECONDS * 1000 + 1;
    expect(service.redeem(late, ORIGIN)).toBe(false);
  });

  it('refuses another origin and keeps the token usable for the right one', () => {
    const { token } = service.issue(ORIGIN);
    expect(service.redeem(token, 'https://holidai.pages.dev')).toBe(false);
    expect(service.redeem(token, ORIGIN)).toBe(true);
  });

  it('refuses a tampered payload or signature', () => {
    const { token } = service.issue(ORIGIN);
    const [body, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), iat: now + 1 })).toString('base64url');
    expect(service.redeem(`${forged}.${signature}`, ORIGIN)).toBe(false);
    expect(service.redeem(`${body}.${signature.slice(0, -2)}AA`, ORIGIN)).toBe(false);
    expect(service.redeem(`${body}.`, ORIGIN)).toBe(false);
  });

  it('refuses a token signed with another secret, and garbage', () => {
    const other = new LeadsTokenService({ ...config, tokenSecret: 'z'.repeat(32) });
    expect(service.redeem(other.issue(ORIGIN).token, ORIGIN)).toBe(false);
    for (const junk of [undefined, null, 42, '', 'a.b.c', 'nodot']) expect(service.redeem(junk, ORIGIN)).toBe(false);
  });
});
