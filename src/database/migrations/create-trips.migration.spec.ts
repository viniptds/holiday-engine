import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateTrips1759449600000 } from './1759449600000-create-trips.js';
import { Trip } from '../../trips/trip.entity.js';

function runner() {
  const query = jest.fn(async (_sql: string) => undefined);
  return { query, queryRunner: { query } as unknown as QueryRunner };
}

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('CreateTrips1759449600000', () => {
  it('creates the trips table, its date check and the indexes', async () => {
    const { query, queryRunner } = runner();

    await new CreateTrips1759449600000().up(queryRunner);

    const sql = query.mock.calls.map(([s]) => normalize(s));
    expect(sql[0]).toContain('CREATE TABLE "trips"');
    expect(sql[0]).toContain('"chatId" text NOT NULL');
    expect(sql[0]).toContain('"destination" varchar(100) NOT NULL');
    expect(sql[0]).toContain('"notes" varchar(500)');
    expect(sql[0]).toContain('CONSTRAINT "CHK_trips_dates" CHECK ("endDate" >= "startDate")');
    expect(sql).toContain('CREATE INDEX "IDX_trips_provider_chatId" ON "trips" ("provider", "chatId")');
    expect(sql).toContain('CREATE INDEX "IDX_trips_dates" ON "trips" ("startDate", "endDate")');
  });

  it('drops everything it created, in reverse order', async () => {
    const { query, queryRunner } = runner();

    await new CreateTrips1759449600000().down(queryRunner);

    expect(query.mock.calls.map(([s]) => normalize(s))).toEqual([
      'DROP INDEX "IDX_trips_dates"',
      'DROP INDEX "IDX_trips_provider_chatId"',
      'DROP TABLE "trips"',
    ]);
  });

  // Keeps the entity in sync with the migration, so DB_SYNCHRONIZE=true and migrations agree.
  it('matches the Trip entity indexes and checks', () => {
    const storage = getMetadataArgsStorage();
    const indexes = storage.indices.filter((i) => i.target === Trip).map((i) => [i.name, i.columns]);
    const checks = storage.checks.filter((c) => c.target === Trip).map((c) => [c.name, c.expression]);

    expect(indexes).toEqual(
      expect.arrayContaining([
        ['IDX_trips_provider_chatId', ['provider', 'chatId']],
        ['IDX_trips_dates', ['startDate', 'endDate']],
      ]),
    );
    expect(checks).toEqual([['CHK_trips_dates', '"endDate" >= "startDate"']]);
  });
});
