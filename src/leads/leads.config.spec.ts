import { allowedOrigin, readLeadsConfig } from './leads.config.js';

const SECRET = 'x'.repeat(32);
const SALT = 'y'.repeat(16);

describe('readLeadsConfig (startup guard)', () => {
  it('is closed (no origins) without WEB_ORIGINS, whatever the secrets', () => {
    expect(readLeadsConfig({}).origins).toEqual([]);
    expect(readLeadsConfig({ WEB_ORIGINS: '   ' }).origins).toEqual([]);
  });

  it('parses and normalizes the comma-separated origins', () => {
    const config = readLeadsConfig({ WEB_ORIGINS: ' https://Holid.ai/ , http://localhost:5173,https://holid.ai', LEADS_TOKEN_SECRET: SECRET, LEADS_HASH_SALT: SALT });
    expect(config.origins).toEqual(['https://holid.ai', 'http://localhost:5173']);
  });

  it.each([
    ['a missing token secret', { LEADS_HASH_SALT: SALT }, 'LEADS_TOKEN_SECRET'],
    ['a short token secret', { LEADS_TOKEN_SECRET: 'short', LEADS_HASH_SALT: SALT }, 'LEADS_TOKEN_SECRET'],
    ['a missing salt', { LEADS_TOKEN_SECRET: SECRET }, 'LEADS_HASH_SALT'],
    ['a short salt', { LEADS_TOKEN_SECRET: SECRET, LEADS_HASH_SALT: 'short' }, 'LEADS_HASH_SALT'],
  ])('fails startup with %s when WEB_ORIGINS is set (naming the setting, not its value)', (_name, env, setting) => {
    expect(() => readLeadsConfig({ WEB_ORIGINS: 'https://holid.ai', ...env })).toThrow(setting);
    expect(() => readLeadsConfig({ WEB_ORIGINS: 'https://holid.ai', ...env })).not.toThrow(/short/);
  });

  it('rejects an entry that is not an http(s) origin', () => {
    expect(() => readLeadsConfig({ WEB_ORIGINS: 'holid.ai', LEADS_TOKEN_SECRET: SECRET, LEADS_HASH_SALT: SALT })).toThrow('WEB_ORIGINS');
  });
});

describe('allowedOrigin', () => {
  const config = readLeadsConfig({ WEB_ORIGINS: 'https://holid.ai', LEADS_TOKEN_SECRET: SECRET, LEADS_HASH_SALT: SALT });

  it('matches the Origin header, else the Referer host', () => {
    expect(allowedOrigin(config, 'https://holid.ai', undefined)).toBe('https://holid.ai');
    expect(allowedOrigin(config, undefined, 'https://holid.ai/pricing?x=1')).toBe('https://holid.ai');
  });

  it('refuses other, missing or malformed origins (Origin wins over Referer)', () => {
    expect(allowedOrigin(config, 'https://evil.example', 'https://holid.ai/')).toBeNull();
    expect(allowedOrigin(config, undefined, undefined)).toBeNull();
    expect(allowedOrigin(config, 'null', undefined)).toBeNull();
    expect(allowedOrigin(config, 'https://holid.ai.evil.example', undefined)).toBeNull();
  });
});
