import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddJourneySkips1760800000000 } from './1760800000000-add-journey-skips.js';
import { migrations } from './index.js';
import { TripJourneySkip } from '../../achievements/trip-journey-skip.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddJourneySkips1760800000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddJourneySkips1760800000000', () => {
  it('runs after the moments', () => {
    expect(migrations.indexOf(AddJourneySkips1760800000000)).toBe(migrations.findIndex((m) => m.name === 'AddMoments1760700000000') + 1);
  });

  it('creates trip_journey_skips: unique per trip and key, trip CASCADE, skipper SET NULL', async () => {
    const [sql] = await run('up');
    expect(sql).toContain('CONSTRAINT "PK_trip_journey_skips" PRIMARY KEY ("tripId", "key")');
    expect(sql).toContain('FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE');
    expect(sql).toContain('FOREIGN KEY ("skippedBy") REFERENCES "users" ("id") ON DELETE SET NULL');
    const storage = getMetadataArgsStorage();
    expect(storage.relations.find((r) => r.target === TripJourneySkip && r.propertyName === 'trip')?.options.onDelete).toBe('CASCADE');
    expect(storage.relations.find((r) => r.target === TripJourneySkip && r.propertyName === 'skipper')?.options.onDelete).toBe('SET NULL');
    expect(await run('down')).toEqual(['DROP TABLE "trip_journey_skips"']);
    // TypeORM fails startup if a composite primary key's columns name different constraints.
    const primaries = storage.columns.filter((c) => c.target === TripJourneySkip && c.mode === 'regular' && (c.options as { primary?: boolean }).primary);
    expect(primaries.map((c) => c.propertyName).sort()).toEqual(['key', 'tripId']);
    expect(new Set(primaries.map((c) => (c.options as { primaryKeyConstraintName?: string }).primaryKeyConstraintName))).toEqual(new Set(['PK_trip_journey_skips']));
  });
});
