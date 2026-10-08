import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddItinerary1760500000000 } from './1760500000000-add-itinerary.js';
import { migrations } from './index.js';
import { Trip } from '../../trips/trip.entity.js';
import { TripPlace } from '../../ai/entities/trip-place.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddItinerary1760500000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddItinerary1760500000000', () => {
  it('runs after the AI tables it changes', () => {
    const names = migrations.map((m) => m.name);
    expect(names.indexOf('AddItinerary1760500000000')).toBeGreaterThan(names.indexOf('CreateAiTables1760400000000'));
    expect(names.indexOf('CreateAiTables1760400000000')).toBeGreaterThan(-1);
  });

  it('adds position (0+, default 0) and startTime, backfills positions by (day, createdAt), indexes and versions', async () => {
    const sql = await run('up');

    expect(sql[0]).toBe(
      'ALTER TABLE "trip_places" ADD COLUMN "position" int NOT NULL DEFAULT 0, ADD COLUMN "startTime" time, ' +
        'ADD CONSTRAINT "CHK_trip_places_position" CHECK ("position" >= 0)',
    );
    expect(sql[1]).toContain('row_number() OVER (PARTITION BY "tripId", "day" ORDER BY "createdAt", "id") - 1');
    expect(sql[1]).toMatch(/^UPDATE "trip_places" p SET "position" = ranked."rank"/);
    expect(sql[2]).toBe('CREATE INDEX "IDX_trip_places_tripId_day_position" ON "trip_places" ("tripId", "day", "position")');
    expect(sql[3]).toBe('ALTER TABLE "trips" ADD COLUMN "itineraryVersion" int NOT NULL DEFAULT 0');
  });

  it('reverts everything', async () => {
    expect(await run('down')).toEqual([
      'ALTER TABLE "trips" DROP COLUMN "itineraryVersion"',
      'DROP INDEX "IDX_trip_places_tripId_day_position"',
      'ALTER TABLE "trip_places" DROP CONSTRAINT "CHK_trip_places_position", DROP COLUMN "startTime", DROP COLUMN "position"',
    ]);
  });

  it('matches the entities', () => {
    const storage = getMetadataArgsStorage();
    const column = (target: Function, name: string) => storage.columns.find((c) => c.target === target && c.propertyName === name)?.options;

    expect(column(TripPlace, 'position')).toMatchObject({ type: 'int', default: 0 });
    expect(column(TripPlace, 'startTime')).toMatchObject({ type: 'time', nullable: true });
    expect(column(Trip, 'itineraryVersion')).toMatchObject({ type: 'int', default: 0 });
    expect(storage.indices.find((i) => i.target === TripPlace && i.name === 'IDX_trip_places_tripId_day_position')?.columns).toEqual([
      'tripId',
      'day',
      'position',
    ]);
    expect(storage.checks.find((c) => c.target === TripPlace && c.name === 'CHK_trip_places_position')?.expression).toBe('"position" >= 0');
  });
});
