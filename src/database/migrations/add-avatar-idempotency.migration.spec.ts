import { jest } from '@jest/globals';
import { QueryRunner } from 'typeorm';
import { AddAvatarIdempotency1761100000000 } from './1761100000000-add-avatar-idempotency.js';
import { migrations } from './index.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddAvatarIdempotency1761100000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddAvatarIdempotency1761100000000', () => {
  it('runs after the notifications', () => {
    const index = migrations.indexOf(AddAvatarIdempotency1761100000000);
    expect(index).toBeGreaterThan(0);
    expect(migrations[index - 1]?.name).toBe('AddNotificationsChecklist1761000000000');
  });

  it('adds the avatar fields (existing users keep Google, backfilled) and the tables', async () => {
    const sql = await run('up');
    expect(sql[0]).toBe(`ALTER TABLE "users" ADD COLUMN "avatarSource" text NOT NULL DEFAULT 'google', ADD COLUMN "googlePictureUrl" text, ADD COLUMN "avatarKey" text`);
    expect(sql).toContain(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_avatarSource" CHECK ("avatarSource" IN ('google', 'custom', 'none'))`);
    expect(sql).toContain('UPDATE "users" SET "googlePictureUrl" = "avatarUrl" WHERE "avatarUrl" IS NOT NULL');
    expect(sql.join('\n')).toContain('CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("userId", "key")');
  });

  it('reverts', async () => {
    expect((await run('down')).at(-1)).toBe('ALTER TABLE "users" DROP COLUMN "avatarKey", DROP COLUMN "googlePictureUrl", DROP COLUMN "avatarSource"');
  });
});
