import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateSuggestedEvents1759536000000 } from './1759536000000-create-suggested-events.js';
import { migrations } from './index.js';
import { SuggestedEvent } from '../../events/suggested-event.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('CreateSuggestedEvents1759536000000', () => {
  it('runs after the trips migration it references', () => {
    const names = migrations.map((m) => m.name);

    expect(names.indexOf('CreateSuggestedEvents1759536000000')).toBeGreaterThan(names.indexOf('CreateTrips1759449600000'));
  });

  it('creates the table with the contract unique (tripId, externalId) and a cascading FK to trips', async () => {
    const query = jest.fn(async (_sql: string) => undefined);

    await new CreateSuggestedEvents1759536000000().up({ query } as unknown as QueryRunner);

    const sql = normalize(query.mock.calls[0][0]);
    expect(sql).toContain('CREATE TABLE "suggested_events"');
    expect(sql).toContain('CONSTRAINT "UQ_suggested_events_tripId_externalId" UNIQUE ("tripId", "externalId")');
    expect(sql).toContain('REFERENCES "trips" ("id") ON DELETE CASCADE');
  });

  it('drops the table', async () => {
    const query = jest.fn(async (_sql: string) => undefined);

    await new CreateSuggestedEvents1759536000000().down({ query } as unknown as QueryRunner);

    expect(query.mock.calls.map(([s]) => normalize(s))).toEqual(['DROP TABLE "suggested_events"']);
  });

  it('matches the SuggestedEvent entity unique constraint and relation', () => {
    const storage = getMetadataArgsStorage();
    const uniques = storage.uniques.filter((u) => u.target === SuggestedEvent).map((u) => [u.name, u.columns]);
    const relation = storage.relations.find((r) => r.target === SuggestedEvent && r.propertyName === 'trip');

    expect(uniques).toEqual([['UQ_suggested_events_tripId_externalId', ['tripId', 'externalId']]]);
    expect(relation?.options.onDelete).toBe('CASCADE');
  });
});
