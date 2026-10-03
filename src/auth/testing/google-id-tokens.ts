import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/**
 * Test-only: signs Google-style ID tokens (RS256) with a local key pair, and exposes the matching
 * "certs" so `GoogleTokenVerifier` can run its real checks without fetching Google's certs.
 * Excluded from the build (tsconfig.build.json).
 */
export const TEST_CLIENT_IDS = ['web-client.apps.googleusercontent.com', 'ios-client.apps.googleusercontent.com', 'android-client.apps.googleusercontent.com'];

export type GoogleClaims = Record<string, unknown>;

export class TestGoogleIssuer {
  readonly kid = 'test-kid';
  private readonly privateKey: KeyObject;
  readonly certs: Record<string, string>;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.certs = { [this.kid]: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  }

  claims(overrides: GoogleClaims = {}, now = Date.now()): GoogleClaims {
    const iat = Math.floor(now / 1000);
    return {
      iss: 'https://accounts.google.com',
      aud: TEST_CLIENT_IDS[0],
      sub: '109876543210987654321',
      email: 'ana@example.com',
      email_verified: true,
      name: 'Ana Silva',
      picture: 'https://lh3.googleusercontent.com/a/ana',
      iat,
      exp: iat + 3600,
      ...overrides,
    };
  }

  sign(claims: GoogleClaims, kid = this.kid, key: KeyObject = this.privateKey): string {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(claims)}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
  }

  token(overrides: GoogleClaims = {}): string {
    return this.sign(this.claims(overrides));
  }

  /** A token whose signature comes from a different key. */
  forgedToken(overrides: GoogleClaims = {}): string {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return this.sign(this.claims(overrides), this.kid, privateKey);
  }
}
