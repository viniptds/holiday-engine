import { resolveJwtSecret } from './jwt-secret.js';

describe('resolveJwtSecret', () => {
  const strong = 'x'.repeat(32);

  it('returns a secret of at least 32 characters', () => {
    expect(resolveJwtSecret(strong, 'production')).toBe(strong);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['31 characters', 'x'.repeat(31)],
  ])('fails startup when the secret is %s', (_label, secret) => {
    expect(() => resolveJwtSecret(secret, 'production')).toThrow(/JWT_SECRET/);
    expect(() => resolveJwtSecret(secret, undefined)).toThrow(/JWT_SECRET/);
  });

  it('uses a random secret under NODE_ENV=test when none is set', () => {
    const a = resolveJwtSecret(undefined, 'test');
    const b = resolveJwtSecret(undefined, 'test');

    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });

  it('accepts a short secret under NODE_ENV=test', () => {
    expect(resolveJwtSecret('short', 'test')).toBe('short');
  });
});
