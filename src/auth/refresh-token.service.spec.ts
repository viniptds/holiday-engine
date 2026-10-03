import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import { appDb } from '../testing/app-db.js';
import { RefreshTokenService, REFRESH_TOKEN_TTL_MS, hashRefreshToken } from './refresh-token.service.js';
import { RefreshToken } from './refresh-token.entity.js';

/** Over InMemoryDb, whose transactions and row locks behave like Postgres's for these calls. */
describe('RefreshTokenService', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  const db = appDb();
  const service = new RefreshTokenService(db.repository(RefreshToken) as unknown as Repository<RefreshToken>);
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

  beforeEach(() => {
    db.clear();
    db.afterRead = undefined;
    warn.mockClear();
  });

  afterAll(() => warn.mockRestore());

  const row = (token: string) => db.all(RefreshToken, { tokenHash: hashRefreshToken(token) })[0];
  const live = (userId: string) => db.all(RefreshToken, { userId }).filter((t) => t.revokedAt === null);

  it('issues 32 random bytes as base64url and stores only the SHA-256 hash, valid 30 days', async () => {
    const { token, id } = await service.issue('u1', now);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const [saved] = db.all(RefreshToken);
    expect(saved).toMatchObject({
      id,
      userId: 'u1',
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      revokedAt: null,
      replacedById: null,
    });
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it('rotates: revokes the old token, issues a new one and links it', async () => {
    const { token: old } = await service.issue('u1', now);

    const result = await service.rotate(old, now);

    expect(result).toEqual({ userId: 'u1', token: expect.any(String) });
    expect(row(old)).toMatchObject({ revokedAt: now, replacedById: row(result.token).id });
    expect(row(result.token).revokedAt).toBeNull();
  });

  it('rejects an unknown token', async () => {
    await expect(service.rotate('nope', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(db.all(RefreshToken)).toEqual([]);
  });

  it('rejects an expired token without issuing a new one', async () => {
    const { token } = await service.issue('u1', new Date(now.getTime() - REFRESH_TOKEN_TTL_MS));

    await expect(service.rotate(token, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(db.all(RefreshToken)).toHaveLength(1);
    expect(row(token).revokedAt).toBeNull();
  });

  it('revokes every token of the user, the replacement chain included, when a rotated token is reused', async () => {
    const { token: t0 } = await service.issue('u1', now);
    const { token: t1 } = await service.rotate(t0, now);
    const { token: t2 } = await service.rotate(t1, now);
    const { token: otherDevice } = await service.issue('u1', now);
    await service.issue('u2', now);

    await expect(service.rotate(t0, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(row(t2).revokedAt).toEqual(now);
    expect(row(otherDevice).revokedAt).toEqual(now);
    expect(live('u1')).toEqual([]);
    expect(live('u2')).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('reused for user u1'));
  });

  // L3: the loser used to revoke "all" before the winner's replacement existed, so it survived.
  it('leaves no live session when the same token is rotated twice concurrently', async () => {
    const { token } = await service.issue('u1', now);
    // Hold each locked read open a moment, so the second rotation arrives while the first is mid-flight.
    db.afterRead = () => new Promise((resolve) => setTimeout(resolve, 10));

    const results = await Promise.allSettled([service.rotate(token, now), service.rotate(token, now)]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{ token: string }>;
    expect(row(winner.value.token).revokedAt).toEqual(now);
    expect(live('u1')).toEqual([]);
    db.afterRead = undefined;
    await expect(service.rotate(winner.value.token, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });

  it('rejects a logged-out token with 401 without revoking the user other sessions', async () => {
    const { token } = await service.issue('u1', now);
    const { token: otherDevice } = await service.issue('u1', now);
    await service.revoke(token, now);

    await expect(service.rotate(token, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(row(otherDevice).revokedAt).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats a token revoked by revokeAllForUser like a logged-out one', async () => {
    const { token } = await service.issue('u1', now);
    await service.revokeAllForUser('u1', now);
    const { token: later } = await service.issue('u1', now);

    await expect(service.rotate(token, now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(row(later).revokedAt).toBeNull();
  });

  it('revokes a single live token by hash', async () => {
    const { token } = await service.issue('u1', now);
    const { token: other } = await service.issue('u1', now);

    await service.revoke(token, now);

    expect(row(token).revokedAt).toEqual(now);
    expect(row(other).revokedAt).toBeNull();
  });
});
