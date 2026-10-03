import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateTripInvites1760186400000 } from './1760186400000-create-trip-invites.js';
import { migrations } from './index.js';
import { TripInvite } from '../../members/trip-invite.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new CreateTripInvites1760186400000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('CreateTripInvites1760186400000', () => {
  it('runs after the app trips migration', () => {
    const names = migrations.map((m) => m.name);

    expect(names.indexOf('CreateTripInvites1760186400000')).toBeGreaterThan(names.indexOf('AppTrips1760100000000'));
  });

  it('creates trip_invites with a unique token hash, a role check and a cascading FK to trips only', async () => {
    const [create, ...indexes] = await run('up');

    expect(create).toContain('CREATE TABLE "trip_invites"');
    for (const part of [
      '"email" varchar(254),',
      '"tokenHash" varchar(64) NOT NULL',
      '"createdBy" uuid NOT NULL',
      '"expiresAt" timestamptz NOT NULL',
      '"acceptedBy" uuid,',
      '"acceptedAt" timestamptz,',
      '"revokedAt" timestamptz,',
      'CONSTRAINT "UQ_trip_invites_tokenHash" UNIQUE ("tokenHash")',
      `CONSTRAINT "CHK_trip_invites_role" CHECK ("role" IN ('editor', 'viewer'))`,
      'CONSTRAINT "FK_trip_invites_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE',
    ]) {
      expect(create).toContain(part);
    }
    expect(create).not.toContain('"users"');
    expect(indexes).toEqual([
      'CREATE INDEX "IDX_trip_invites_tripId" ON "trip_invites" ("tripId")',
      'CREATE INDEX "IDX_trip_invites_createdBy" ON "trip_invites" ("createdBy")',
    ]);
  });

  it('drops everything it created, in reverse order', async () => {
    expect(await run('down')).toEqual([
      'DROP INDEX "IDX_trip_invites_createdBy"',
      'DROP INDEX "IDX_trip_invites_tripId"',
      'DROP TABLE "trip_invites"',
    ]);
  });

  it('matches the TripInvite entity constraints, indexes and relation', async () => {
    const [create] = await run('up');
    const storage = getMetadataArgsStorage();
    const uniques = storage.uniques.filter((u) => u.target === TripInvite).map((u) => [u.name, u.columns]);
    const checks = storage.checks.filter((c) => c.target === TripInvite);
    const indexes = storage.indices.filter((i) => i.target === TripInvite).map((i) => [i.name, i.columns]);
    const relation = storage.relations.find((r) => r.target === TripInvite && r.propertyName === 'trip');

    expect(uniques).toEqual([['UQ_trip_invites_tokenHash', ['tokenHash']]]);
    expect(checks).toHaveLength(1);
    expect(create).toContain(`CONSTRAINT "${checks[0].name}" CHECK (${checks[0].expression})`);
    expect(indexes).toEqual(
      expect.arrayContaining([
        ['IDX_trip_invites_tripId', ['tripId']],
        ['IDX_trip_invites_createdBy', ['createdBy']],
      ]),
    );
    expect(relation?.options.onDelete).toBe('CASCADE');
  });
});
