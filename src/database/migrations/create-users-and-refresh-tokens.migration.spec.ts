import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateUsers1760000000000 } from './1760000000000-create-users.js';
import { CreateRefreshTokens1760000100000 } from './1760000100000-create-refresh-tokens.js';
import { migrations } from './index.js';
import { User } from '../../users/user.entity.js';
import { RefreshToken } from '../../auth/refresh-token.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function sqlOf(run: (runner: QueryRunner) => Promise<void>) {
  const query = jest.fn(async (_sql: string) => undefined);
  await run({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([sql]) => normalize(sql));
}

describe('CreateUsers1760000000000 / CreateRefreshTokens1760000100000', () => {
  it('are registered, refresh tokens after the users table they reference', () => {
    const names = migrations.map((m) => m.name);

    expect(names.indexOf('CreateUsers1760000000000')).toBeGreaterThan(-1);
    expect(names.indexOf('CreateRefreshTokens1760000100000')).toBeGreaterThan(names.indexOf('CreateUsers1760000000000'));
  });

  it('makes googleSub unique among users that are not deleted', async () => {
    const sql = await sqlOf((r) => new CreateUsers1760000000000().up(r));

    expect(sql[0]).toContain('CREATE TABLE "users"');
    expect(sql[0]).toContain('"deletedAt" timestamptz,');
    expect(sql[1]).toBe('CREATE UNIQUE INDEX "UQ_users_googleSub_active" ON "users" ("googleSub") WHERE "deletedAt" IS NULL');
  });

  it('creates refresh_tokens with a unique hash and a cascading FK to users', async () => {
    const sql = await sqlOf((r) => new CreateRefreshTokens1760000100000().up(r));

    expect(sql[0]).toContain('CREATE TABLE "refresh_tokens"');
    expect(sql[0]).toContain('FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE');
    expect(sql).toContain('CREATE UNIQUE INDEX "UQ_refresh_tokens_tokenHash" ON "refresh_tokens" ("tokenHash")');
  });

  it('drops in reverse order', async () => {
    expect(await sqlOf((r) => new CreateRefreshTokens1760000100000().down(r))).toEqual([
      'DROP INDEX "IDX_refresh_tokens_userId"',
      'DROP INDEX "UQ_refresh_tokens_tokenHash"',
      'DROP TABLE "refresh_tokens"',
    ]);
    expect(await sqlOf((r) => new CreateUsers1760000000000().down(r))).toEqual([
      'DROP INDEX "UQ_users_googleSub_active"',
      'DROP TABLE "users"',
    ]);
  });

  it('match the entity indexes and relation', () => {
    const storage = getMetadataArgsStorage();
    const indexes = (target: object) =>
      storage.indices.filter((i) => i.target === target).map((i) => ({ name: i.name, unique: !!i.unique, where: i.where }));

    expect(indexes(User)).toEqual([{ name: 'UQ_users_googleSub_active', unique: true, where: '"deletedAt" IS NULL' }]);
    expect(indexes(RefreshToken)).toEqual(
      expect.arrayContaining([
        { name: 'UQ_refresh_tokens_tokenHash', unique: true, where: undefined },
        { name: 'IDX_refresh_tokens_userId', unique: false, where: undefined },
      ]),
    );
    const relation = storage.relations.find((r) => r.target === RefreshToken && r.propertyName === 'user');
    expect(relation?.options.onDelete).toBe('CASCADE');
  });
});
