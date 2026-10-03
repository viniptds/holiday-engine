import { jest } from '@jest/globals';
import { IsNull } from 'typeorm';
import type { Repository } from 'typeorm';
import { RefreshTokenService, REFRESH_TOKEN_TTL_MS, hashRefreshToken } from './refresh-token.service.js';
import { RefreshToken } from './refresh-token.entity.js';

describe('RefreshTokenService', () => {
  const now = new Date('2026-10-03T12:00:00.000Z');
  let repo: {
    create: jest.Mock<(data: Partial<RefreshToken>) => Partial<RefreshToken>>;
    save: jest.Mock<(row: Partial<RefreshToken>) => Promise<Partial<RefreshToken>>>;
    findOne: jest.Mock<(options: unknown) => Promise<Partial<RefreshToken> | null>>;
    update: jest.Mock<(criteria: unknown, changes: unknown) => Promise<{ affected: number }>>;
  };
  let service: RefreshTokenService;

  beforeEach(() => {
    repo = {
      create: jest.fn((data: Partial<RefreshToken>) => data),
      save: jest.fn(async (row: Partial<RefreshToken>) => ({ ...row, id: 'new-id' })),
      findOne: jest.fn(async () => null),
      update: jest.fn(async () => ({ affected: 1 })),
    };
    service = new RefreshTokenService(repo as unknown as Repository<RefreshToken>);
  });

  const stored = (overrides: Partial<RefreshToken> = {}): Partial<RefreshToken> => ({
    id: 'old-id',
    userId: 'u1',
    tokenHash: hashRefreshToken('old'),
    expiresAt: new Date(now.getTime() + 1000),
    revokedAt: null,
    replacedById: null,
    ...overrides,
  });

  it('issues 32 random bytes as base64url and stores only the SHA-256 hash, valid 30 days', async () => {
    const { token, id } = await service.issue('u1', now);

    expect(id).toBe('new-id');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const saved = repo.save.mock.calls[0][0];
    expect(saved).toEqual({
      userId: 'u1',
      tokenHash: hashRefreshToken(token),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
      revokedAt: null,
      replacedById: null,
    });
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  it('rotates: claims the old token, issues a new one and links it', async () => {
    repo.findOne.mockResolvedValueOnce(stored());

    const result = await service.rotate('old', now);

    expect(result).toEqual({ userId: 'u1', token: expect.any(String) });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { tokenHash: hashRefreshToken('old') } });
    expect(repo.update.mock.calls).toEqual([
      [{ id: 'old-id', revokedAt: IsNull() }, { revokedAt: now }],
      [{ id: 'old-id' }, { replacedById: 'new-id' }],
    ]);
  });

  it('rejects an unknown token', async () => {
    await expect(service.rotate('nope', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('rejects an expired token without issuing a new one', async () => {
    repo.findOne.mockResolvedValueOnce(stored({ expiresAt: now }));

    await expect(service.rotate('old', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('revokes all of the user tokens when a revoked token is reused', async () => {
    repo.findOne.mockResolvedValueOnce(stored({ revokedAt: new Date(now.getTime() - 1000) }));

    await expect(service.rotate('old', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(repo.update).toHaveBeenCalledWith({ userId: 'u1', revokedAt: IsNull() }, { revokedAt: now });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('treats losing a concurrent rotation as reuse', async () => {
    repo.findOne.mockResolvedValueOnce(stored());
    repo.update.mockResolvedValueOnce({ affected: 0 });

    await expect(service.rotate('old', now)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(repo.update).toHaveBeenLastCalledWith({ userId: 'u1', revokedAt: IsNull() }, { revokedAt: now });
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('revokes a single live token by hash', async () => {
    await service.revoke('old', now);

    expect(repo.update).toHaveBeenCalledWith({ tokenHash: hashRefreshToken('old'), revokedAt: IsNull() }, { revokedAt: now });
  });
});
