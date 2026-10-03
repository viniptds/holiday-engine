import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../app-common/app-error.js';
import type { GoogleIdentity } from '../users/users.service.js';

export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export function parseClientIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/**
 * Verifies Google ID tokens: signature (Google's published certs), audience (any of
 * `GOOGLE_CLIENT_IDS`), issuer and expiry, plus a verified email. Any failure is a 401;
 * failing to fetch Google's certs is not the client's fault and surfaces as a 500.
 * Tests replace this provider.
 */
@Injectable()
export class GoogleTokenVerifier {
  private readonly logger = new Logger(GoogleTokenVerifier.name);
  private readonly audience: string[];
  // Caches Google's certs until they expire.
  readonly client = new OAuth2Client({ issuers: GOOGLE_ISSUERS });

  constructor(config: ConfigService) {
    this.audience = parseClientIds(config.get<string>('GOOGLE_CLIENT_IDS'));
    if (this.audience.length === 0) {
      this.logger.warn('GOOGLE_CLIENT_IDS is not set: every Google sign-in will be rejected.');
    }
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    // Without an audience google-auth-library would skip the audience check: refuse instead.
    if (this.audience.length === 0) throw invalidGoogleToken();

    const { certs } = await this.client.getFederatedSignonCertsAsync();
    let payload;
    try {
      const ticket = await this.client.verifySignedJwtWithCertsAsync(idToken, certs, this.audience, GOOGLE_ISSUERS);
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.debug(`Google ID token rejected: ${error instanceof Error ? error.message : String(error)}`);
      throw invalidGoogleToken();
    }
    if (!payload?.sub || !payload.email || payload.email_verified !== true) throw invalidGoogleToken();

    return { sub: payload.sub, email: payload.email, name: payload.name ?? null, picture: payload.picture ?? null };
  }
}

const invalidGoogleToken = () => new AppError('UNAUTHENTICATED', 'Invalid Google token');
