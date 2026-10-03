import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull } from 'typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { RefreshToken } from './refresh-token.entity.js';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const hashRefreshToken = (token: string) => createHash('sha256').update(token).digest('hex');

const invalidRefreshToken = () => new AppError('UNAUTHENTICATED', 'Invalid refresh token');

/** Most tokens a reuse revocation follows down one `replacedById` chain (a guard against a cycle). */
const MAX_CHAIN = 1000;

/**
 * Opaque refresh tokens: 32 random bytes (base64url), stored as a SHA-256 hash, valid 30 days, rotated on use.
 * A token is revoked either by rotation (`replacedById` set) or by logout / account-wide revocation
 * (`replacedById` null). Only presenting a rotated token again counts as theft.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(@InjectRepository(RefreshToken) private readonly tokens: Repository<RefreshToken>) {}

  async issue(userId: string, now = new Date(), manager?: EntityManager): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString('base64url');
    const repo = manager ? manager.getRepository(RefreshToken) : this.tokens;
    const saved = await repo.save(
      repo.create({
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
   * Revokes the token and issues its replacement, in one transaction holding a row lock on the old
   * token, so a concurrent rotation of the same token waits and then sees it rotated. Presenting a
   * rotated token again means it leaked (or a client raced itself): every token of the user is revoked,
   * the replacement chain included. A token revoked by logout just gets 401. Throws `UNAUTHENTICATED`.
   */
  async rotate(token: string, now = new Date()): Promise<{ userId: string; token: string }> {
    const outcome = await this.tokens.manager.transaction(async (manager) => {
      const current = await manager.findOne(RefreshToken, {
        where: { tokenHash: hashRefreshToken(token) },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) return { kind: 'invalid' } as const;
      if (current.revokedAt) return current.replacedById ? ({ kind: 'reused', current } as const) : ({ kind: 'invalid' } as const);
      if (current.expiresAt.getTime() <= now.getTime()) return { kind: 'invalid' } as const;

      const next = await this.issue(current.userId, now, manager);
      await manager.update(RefreshToken, { id: current.id }, { revokedAt: now, replacedById: next.id });
      return { kind: 'rotated', userId: current.userId, token: next.token } as const;
    });

    if (outcome.kind === 'rotated') return { userId: outcome.userId, token: outcome.token };
    // Revoked after the transaction: throwing inside it would roll the revocation back.
    if (outcome.kind === 'reused') await this.reuseDetected(outcome.current, now);
    throw invalidRefreshToken();
  }

  /** Revokes one token, if it's live (logout). Unknown tokens are ignored. */
  async revoke(token: string, now = new Date()): Promise<void> {
    await this.tokens.update({ tokenHash: hashRefreshToken(token), revokedAt: IsNull() }, { revokedAt: now });
  }

  async revokeAllForUser(userId: string, now = new Date()): Promise<void> {
    await this.tokens.update({ userId, revokedAt: IsNull() }, { revokedAt: now });
  }

  private async reuseDetected(reused: RefreshToken, now: Date): Promise<void> {
    this.logger.warn(`Rotated refresh token reused for user ${reused.userId}; revoking all of their tokens.`);
    await this.revokeAllForUser(reused.userId, now);
    // Also the tokens issued from it, by id: covers the chain whatever user it's on.
    const seen = new Set<string>([reused.id]);
    for (let id = reused.replacedById; id && !seen.has(id) && seen.size < MAX_CHAIN; ) {
      seen.add(id);
      await this.tokens.update({ id, revokedAt: IsNull() }, { revokedAt: now });
      id = (await this.tokens.findOne({ where: { id } }))?.replacedById ?? null;
    }
  }
}
