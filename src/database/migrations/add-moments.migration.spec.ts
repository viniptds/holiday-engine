import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddMoments1760700000000 } from './1760700000000-add-moments.js';
import { migrations } from './index.js';
import { Moment } from '../../moments/moment.entity.js';
import { UserAchievement } from '../../achievements/user-achievement.entity.js';
import { Trip } from '../../trips/trip.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddMoments1760700000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddMoments1760700000000', () => {
  it('runs last, after billing', () => {
    expect(migrations.at(-1)).toBe(AddMoments1760700000000);
    expect(migrations.at(-2)?.name).toBe('AddBilling1760600000000');
  });

  it('adds the trip columns, moments (trip SET NULL) and user_achievements with a NULL-safe unique index', async () => {
    const sql = await run('up');

    expect(sql[0]).toBe('ALTER TABLE "trips" ADD COLUMN "countryCode" varchar(2), ADD COLUMN "cityPlaceId" text');
    const moments = sql.find((s) => s.startsWith('CREATE TABLE "moments"'))!;
    expect(moments).toContain('CONSTRAINT "FK_moments_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE SET NULL');
    expect(moments).toContain('CONSTRAINT "FK_moments_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE');
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "UQ_user_achievements_user_key_trip" ON "user_achievements" ("userId", "key", COALESCE("tripId", '00000000-0000-0000-0000-000000000000'::uuid))`,
    );
  });

  it('matches the entities (checks, relations, columns)', async () => {
    const sql = (await run('up')).join('\n');
    const storage = getMetadataArgsStorage();
    for (const check of storage.checks.filter((c) => c.target === Moment)) expect(sql).toContain(`CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    for (const index of storage.indices.filter((i) => i.target === Moment || i.target === UserAchievement)) expect(sql).toContain(`"${index.name}"`);
    expect(storage.relations.find((r) => r.target === Moment && r.propertyName === 'trip')?.options.onDelete).toBe('SET NULL');
    expect(storage.relations.find((r) => r.target === UserAchievement && r.propertyName === 'trip')?.options.onDelete).toBe('CASCADE');
    for (const property of ['countryCode', 'cityPlaceId']) {
      expect(storage.columns.find((c) => c.target === Trip && c.propertyName === property)?.options.nullable).toBe(true);
    }
  });

  it('reverts everything', async () => {
    expect(await run('down')).toEqual(['DROP TABLE "user_achievements"', 'DROP TABLE "moments"', 'ALTER TABLE "trips" DROP COLUMN "cityPlaceId", DROP COLUMN "countryCode"']);
  });
});
