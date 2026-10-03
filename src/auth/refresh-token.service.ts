import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import type { Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { RefreshToken } from './refresh-token.entity.js';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalidRefreshToken = () => new AppError('UNAUTHENTICATED', 'Invalid refresh token');

/** Opaque refresh tokens: 32 random bytes (base64url), stored as a SHA-256 hash, valid 30 days, rotated on use. */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(@InjectRepository(RefreshToken) private readonly tokens: Repository<RefreshToken>) {}

  async issue(userId: string, now = new Date()): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const saved = await this.tokens.save(
      this.tokens.create({
        userId,
        tokenHash: hashRefreshToken(token),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
        revokedAt: null,
        replacedById: null,
      }),
    );
    return { token, id: saved.id };
  }

  /**
   * Revokes the token and issues its replacement. A token that was already revoked means it leaked
   * (or a client raced itself): every token of that user is revoked. Throws `UNAUTHENTICATED`.
   */
  async rotate(token: string, now = new Date()): Promise<{ userId: string; token: string }> {
    const current = await this.tokens.findOne({ where: { tokenHash: hashRefreshToken(token) } });
    if (!current) throw invalidRefreshToken();
    if (current.revokedAt) return this.reuseDetected(current.userId, now);
    if (current.expiresAt.getTime() <= now.getTime()) throw invalidRefreshToken();

    // Claim the token atomically, so two concurrent refreshes can't both rotate it.
    const claimed = await this.tokens.update({ id: current.id, revokedAt: IsNull() }, { revokedAt: now });
    if (claimed.affected !== 1) return this.reuseDetected(current.userId, now);

    const next = await this.issue(current.userId, now);
    await this.tokens.update({ id: current.id }, { replacedById: next.id });
    return { userId: current.userId, token: next.token };
  }

  /** Revokes one token, if it's live. Unknown tokens are ignored. */
  async revoke(token: string, now = new Date()): Promise<void> {
    await this.tokens.update({ tokenHash: hashRefreshToken(token), revokedAt: IsNull() }, { revokedAt: now });
  }

  async revokeAllForUser(userId: string, now = new Date()): Promise<void> {
    await this.tokens.update({ userId, revokedAt: IsNull() }, { revokedAt: now });
  }

  private async reuseDetected(userId: string, now: Date): Promise<never> {
    this.logger.warn(`Revoked refresh token reused for user ${userId}; revoking all of their tokens.`);
    await this.revokeAllForUser(userId, now);
    throw invalidRefreshToken();
  }
}
