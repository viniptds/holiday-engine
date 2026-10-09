import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddMomentDays1760900000000 } from './1760900000000-add-moment-days.js';
import { migrations } from './index.js';
import { Moment } from '../../moments/moment.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddMomentDays1760900000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddMomentDays1760900000000', () => {
  it('runs after the journey skips', () => {
    expect(migrations.indexOf(AddMomentDays1760900000000)).toBe(migrations.findIndex((m) => m.name === 'AddJourneySkips1760800000000') + 1);
  });

  it('adds source (existing rows → camera) and day, with the entity checks', async () => {
    const sql = await run('up');
    expect(sql[0]).toBe(`ALTER TABLE "moments" ADD COLUMN "source" text NOT NULL DEFAULT 'camera', ADD COLUMN "day" smallint`);
    for (const check of getMetadataArgsStorage().checks.filter((c) => c.target === Moment && ['CHK_moments_source', 'CHK_moments_day'].includes(c.name!))) {
      expect(sql).toContain(`ALTER TABLE "moments" ADD CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    }
  });

  it("backfills camera days from takenOn relative to the trip's start, only inside the trip", async () => {
    const backfill = (await run('up'))[3];
    expect(backfill).toBe(
      `UPDATE "moments" m SET "day" = (m."takenOn" - t."startDate") + 1 FROM "trips" t WHERE m."tripId" = t."id" AND m."status" = 'ready' AND m."takenOn" BETWEEN t."startDate" AND t."endDate"`,
    );
  });

  it('reverts', async () => {
    expect(await run('down')).toEqual([
      'ALTER TABLE "moments" DROP CONSTRAINT "CHK_moments_day", DROP CONSTRAINT "CHK_moments_source"',
      'ALTER TABLE "moments" DROP COLUMN "day", DROP COLUMN "source"',
    ]);
  });
});
