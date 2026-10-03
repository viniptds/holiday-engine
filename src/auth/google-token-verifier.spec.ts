import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { OAuth2Client } from 'google-auth-library';
import { GoogleTokenVerifier, parseClientIds } from './google-token-verifier.js';
import { TEST_CLIENT_IDS, TestGoogleIssuer } from './testing/google-id-tokens.js';

describe('parseClientIds', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseClientIds(' web , ios,,android ')).toEqual(['web', 'ios', 'android']);
    expect(parseClientIds(undefined)).toEqual([]);
    expect(parseClientIds('')).toEqual([]);
  });
});

/** Runs google-auth-library's real checks, with Google's cert endpoint replaced by a local key. */
describe('GoogleTokenVerifier', () => {
  const issuer = new TestGoogleIssuer();

  function verifierWith(clientIds: string | undefined) {
    const verifier = new GoogleTokenVerifier(new ConfigService(clientIds === undefined ? {} : { GOOGLE_CLIENT_IDS: clientIds }));
    const fetchCerts = jest
      .spyOn(verifier.client, 'getFederatedSignonCertsAsync')
      .mockResolvedValue({ certs: issuer.certs } as Awaited<ReturnType<OAuth2Client['getFederatedSignonCertsAsync']>>);
    return { verifier, fetchCerts };
  }

  const unauthenticated = { code: 'UNAUTHENTICATED', message: 'Invalid Google token' };

  it('returns the identity of a valid token', async () => {
    const { verifier } = verifierWith(TEST_CLIENT_IDS.join(','));

    await expect(verifier.verify(issuer.token())).resolves.toEqual({
      sub: '109876543210987654321',
      email: 'ana@example.com',
      name: 'Ana Silva',
      picture: 'https://lh3.googleusercontent.com/a/ana',
    });
  });

  it.each(TEST_CLIENT_IDS)('accepts the client id %s as audience', async (aud) => {
    const { verifier } = verifierWith(TEST_CLIENT_IDS.join(','));

    await expect(verifier.verify(issuer.token({ aud }))).resolves.toMatchObject({ sub: '109876543210987654321' });
  });

  it('accepts the issuer without scheme', async () => {
    const { verifier } = verifierWith(TEST_CLIENT_IDS.join(','));

    await expect(verifier.verify(issuer.token({ iss: 'accounts.google.com' }))).resolves.toBeDefined();
  });

  it('maps missing name and picture to null', async () => {
    const { verifier } = verifierWith(TEST_CLIENT_IDS.join(','));

    await expect(verifier.verify(issuer.token({ name: undefined, picture: undefined }))).resolves.toMatchObject({
      name: null,
      picture: null,
    });
  });

  const now = Math.floor(Date.now() / 1000);
  it.each([
    ['a wrong audience', () => issuer.token({ aud: 'someone-else.apps.googleusercontent.com' })],
    ['an expired token', () => issuer.token({ iat: now - 7200, exp: now - 3600 })],
    ['a token not valid yet', () => issuer.token({ iat: now + 3600, exp: now + 7200 })],
    ['a wrong issuer', () => issuer.token({ iss: 'https://evil.example.com' })],
    ['an unverified email', () => issuer.token({ email_verified: false })],
    ['a missing email', () => issuer.token({ email: undefined })],
    ['a forged signature', () => issuer.forgedToken()],
    ['an unknown key id', () => issuer.sign(issuer.claims(), 'other-kid')],
    ['garbage', () => 'not-a-jwt'],
  ])('rejects %s with UNAUTHENTICATED', async (_label, token) => {
    const { verifier } = verifierWith(TEST_CLIENT_IDS.join(','));

    await expect(verifier.verify(token())).rejects.toMatchObject(unauthenticated);
  });

  it('rejects every token when GOOGLE_CLIENT_IDS is not set, without skipping the audience check', async () => {
    const { verifier, fetchCerts } = verifierWith(undefined);

    await expect(verifier.verify(issuer.token())).rejects.toMatchObject(unauthenticated);
    expect(fetchCerts).not.toHaveBeenCalled();
  });

  it('lets a failure to fetch Google certs through (500, not 401)', async () => {
    const { verifier, fetchCerts } = verifierWith(TEST_CLIENT_IDS.join(','));
    fetchCerts.mockRejectedValueOnce(new Error('ENOTFOUND www.googleapis.com'));

    await expect(verifier.verify(issuer.token())).rejects.toThrow('ENOTFOUND');
  });
});
