import { jest } from '@jest/globals';
import { In, QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
import { UsersService } from './users.service.js';
import type { GoogleIdentity } from './users.service.js';
import { User } from './user.entity.js';

describe('UsersService', () => {
  const identity: GoogleIdentity = { sub: 'g1', email: 'ana@example.com', name: 'Ana Silva', picture: 'https://pic/ana' };
  const user = (overrides: Partial<User> = {}): User =>
    Object.assign(new User(), {
      id: 'u1',
      googleSub: 'g1',
      email: 'ana@example.com',
      displayName: 'Ana',
      avatarUrl: 'https://pic/ana',
      homeCity: null,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      deletedAt: null,
      ...overrides,
    });
  let repo: {
    create: jest.Mock<(data: Partial<User>) => Partial<User>>;
    save: jest.Mock<(row: Partial<User>) => Promise<Partial<User>>>;
    findOne: jest.Mock<(options: unknown) => Promise<User | null>>;
    find: jest.Mock<(options: unknown) => Promise<User[]>>;
    softDelete: jest.Mock<(criteria: unknown) => Promise<unknown>>;
  };
  let service: UsersService;

  beforeEach(() => {
    repo = {
      create: jest.fn((data: Partial<User>) => data),
      save: jest.fn(async (row: Partial<User>) => ({ id: 'new', ...row })),
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
      softDelete: jest.fn(async () => ({ affected: 1 })),
    };
    service = new UsersService(repo as unknown as Repository<User>);
  });

  describe('findOrCreateFromGoogle', () => {
    it('creates a user from the Google identity on first sign-in', async () => {
      await service.findOrCreateFromGoogle(identity);

      expect(repo.findOne).toHaveBeenCalledWith({ where: { googleSub: 'g1' } });
      expect(repo.save).toHaveBeenCalledWith({
        googleSub: 'g1',
        email: 'ana@example.com',
        displayName: 'Ana Silva',
        avatarUrl: 'https://pic/ana',
        homeCity: null,
      });
    });

    it.each([
      ['no name', null, 'ana'],
      ['a blank name', '   ', 'ana'],
      ['control characters', 'Ana\u0000Silva', 'Ana Silva'],
      ['a long name', 'x'.repeat(150), 'x'.repeat(100)],
    ])('derives a display name from %s', async (_label, name, expected) => {
      await service.findOrCreateFromGoogle({ ...identity, name });

      expect(repo.save.mock.calls[0][0]).toMatchObject({ displayName: expected });
    });

    it('returns the existing user without writing when nothing changed', async () => {
      const existing = user();
      repo.findOne.mockResolvedValueOnce(existing);

      await expect(service.findOrCreateFromGoogle(identity)).resolves.toBe(existing);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('updates email and avatar from Google but keeps the edited display name', async () => {
      repo.findOne.mockResolvedValueOnce(user({ email: 'old@example.com', avatarUrl: null, displayName: 'Mine' }));

      await service.findOrCreateFromGoogle(identity);

      expect(repo.save.mock.calls[0][0]).toMatchObject({ email: 'ana@example.com', avatarUrl: 'https://pic/ana', displayName: 'Mine' });
    });

    it('returns the user created by a concurrent first sign-in', async () => {
      const winner = user();
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      repo.save.mockRejectedValueOnce(new QueryFailedError('INSERT', [], Object.assign(new Error('dup'), { code: '23505' })));

      await expect(service.findOrCreateFromGoogle(identity)).resolves.toBe(winner);
    });

    it('rethrows other database errors', async () => {
      repo.save.mockRejectedValueOnce(new Error('connection lost'));

      await expect(service.findOrCreateFromGoogle(identity)).rejects.toThrow('connection lost');
    });
  });

  describe('get / update / softDelete', () => {
    it('throws NOT_FOUND for an unknown or deleted user', async () => {
      await expect(service.get('u1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('applies only the fields sent; homeCity null clears it', async () => {
      repo.findOne.mockImplementation(async () => user({ homeCity: 'Porto' }));

      await service.update('u1', { homeCity: null });
      expect(repo.save.mock.calls[0][0]).toMatchObject({ displayName: 'Ana', homeCity: null });

      await service.update('u1', { displayName: 'Ana S.' });
      expect(repo.save.mock.calls[1][0]).toMatchObject({ displayName: 'Ana S.', homeCity: 'Porto' });
    });

    it('soft-deletes by id', async () => {
      await service.softDelete('u1');

      expect(repo.softDelete).toHaveBeenCalledWith({ id: 'u1' });
    });
  });

  describe('getProfiles (UserDirectory)', () => {
    it('returns an empty map without querying for no ids', async () => {
      await expect(service.getProfiles([])).resolves.toEqual(new Map());
      expect(repo.find).not.toHaveBeenCalled();
    });

    it('dedupes ids and maps live users to public profiles', async () => {
      repo.find.mockResolvedValueOnce([user(), user({ id: 'u2', displayName: 'Bo', avatarUrl: null })]);

      const profiles = await service.getProfiles(['u1', 'u2', 'u1', 'gone']);

      expect(repo.find).toHaveBeenCalledWith({ where: { id: In(['u1', 'u2', 'gone']) } });
      expect([...profiles.entries()]).toEqual([
        ['u1', { id: 'u1', displayName: 'Ana', avatarUrl: 'https://pic/ana' }],
        ['u2', { id: 'u2', displayName: 'Bo', avatarUrl: null }],
      ]);
    });
  });
});
