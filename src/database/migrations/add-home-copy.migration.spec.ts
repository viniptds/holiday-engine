import { jest } from '@jest/globals';
import { QueryRunner } from 'typeorm';
import { AddHomeCopy1761200000000 } from './1761200000000-add-home-copy.js';
import { migrations } from './index.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddHomeCopy1761200000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddHomeCopy1761200000000', () => {
  it('runs after the avatar and idempotency migration', () => {
    expect(migrations.at(-2)).toBe(AddHomeCopy1761200000000);
    expect(migrations.at(-3)?.name).toBe('AddAvatarIdempotency1761100000000');
  });

  it('creates home_copy with its unique key per destination, tier, locale and angle', async () => {
    const sql = await run('up');
    expect(sql[0]).toContain('CREATE TABLE "home_copy"');
    expect(sql[0]).toContain(`"angle" text NOT NULL DEFAULT ''`);
    expect(sql[0]).toContain('CONSTRAINT "PK_home_copy_id" PRIMARY KEY ("id")');
    expect(sql).toContain('CREATE UNIQUE INDEX "UQ_home_copy_destination_tier_locale_angle" ON "home_copy" ("destinationId", "tier", "locale", "angle")');
  });

  it('reverts', async () => {
    expect(await run('down')).toEqual(['DROP TABLE "home_copy"']);
  });
});
