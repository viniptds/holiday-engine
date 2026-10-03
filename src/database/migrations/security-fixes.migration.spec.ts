import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateTripRemovals1760200000000 } from './1760200000000-create-trip-removals.js';
import { OneOwnerPerTrip1760200100000 } from './1760200100000-one-owner-per-trip.js';
import { migrations } from './index.js';
import { TripMember } from '../../app-trips/trip-member.entity.js';
import { TripRemoval } from '../../members/trip-removal.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** Runs a migration against a recording query runner; `answer` supplies SELECT results. */
async function run(
  migration: { up(q: QueryRunner): Promise<void>; down(q: QueryRunner): Promise<void> },
  direction: 'up' | 'down',
  answer: (sql: string) => unknown = () => undefined,
): Promise<string[]> {
  const query = jest.fn(async (sql: string) => answer(normalize(sql)));
  await migration[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('security-fix migrations', () => {
  it('run after AddUserForeignKeys, in order', () => {
    const names = migrations.map((m) => m.name);
    const at = names.indexOf('AddUserForeignKeys1760190000000');

    // Right after AddUserForeignKeys, in order (later features' migrations may follow).
    expect(at).toBeGreaterThan(-1);
    expect(names.slice(at, at + 3)).toEqual([
      'AddUserForeignKeys1760190000000',
      'CreateTripRemovals1760200000000',
      'OneOwnerPerTrip1760200100000',
    ]);
  });

  describe('CreateTripRemovals1760200000000', () => {
    it('creates trip_removals keyed by (tripId, userId), with cascading FKs and a userId index', async () => {
      const [create, index] = await run(new CreateTripRemovals1760200000000(), 'up');

      expect(create).toContain('CREATE TABLE "trip_removals"');
      expect(create).toContain('CONSTRAINT "PK_trip_removals" PRIMARY KEY ("tripId", "userId")');
      expect(create).toContain('CONSTRAINT "FK_trip_removals_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE');
      expect(create).toContain('CONSTRAINT "FK_trip_removals_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE');
      expect(create).toContain(
        'CONSTRAINT "FK_trip_removals_removedBy" FOREIGN KEY ("removedBy") REFERENCES "users" ("id") ON DELETE SET NULL',
      );
      expect(create).toContain('"removedAt" timestamptz NOT NULL');
      expect(index).toBe('CREATE INDEX "IDX_trip_removals_userId" ON "trip_removals" ("userId")');
    });

    it('down drops the index and the table', async () => {
      expect(await run(new CreateTripRemovals1760200000000(), 'down')).toEqual([
        'DROP INDEX "IDX_trip_removals_userId"',
        'DROP TABLE "trip_removals"',
      ]);
    });

    it('matches the TripRemoval entity', () => {
      const storage = getMetadataArgsStorage();
      const primary = storage.columns.filter((c) => c.target === TripRemoval && c.options.primary);
      const indexes = storage.indices.filter((i) => i.target === TripRemoval).map((i) => [i.name, i.columns]);
      const fks = storage.joinColumns
        .filter((j) => j.target === TripRemoval)
        .map((j) => [j.name, j.foreignKeyConstraintName]);
      const onDelete = storage.relations
        .filter((r) => r.target === TripRemoval)
        .map((r) => [r.propertyName, r.options.onDelete]);

      expect(primary.map((c) => [c.propertyName, c.options.primaryKeyConstraintName])).toEqual([
        ['tripId', 'PK_trip_removals'],
        ['userId', 'PK_trip_removals'],
      ]);
      expect(indexes).toEqual([['IDX_trip_removals_userId', ['userId']]]);
      expect(fks).toEqual([
        ['tripId', 'FK_trip_removals_tripId'],
        ['userId', 'FK_trip_removals_userId'],
        ['removedBy', 'FK_trip_removals_removedBy'],
      ]);
      expect(onDelete).toEqual([
        ['trip', 'CASCADE'],
        ['user', 'CASCADE'],
        ['remover', 'SET NULL'],
      ]);
    });
  });

  describe('OneOwnerPerTrip1760200100000', () => {
    const INDEX = `CREATE UNIQUE INDEX "UQ_trip_members_one_owner" ON "trip_members" ("tripId") WHERE "role" = 'owner'`;

    it('checks the existing data, then adds the partial unique index', async () => {
      const sql = await run(new OneOwnerPerTrip1760200100000(), 'up', (q) => (q.startsWith('SELECT') ? [] : undefined));

      expect(sql).toHaveLength(2);
      expect(sql[0]).toMatch(/^SELECT "tripId", COUNT\(\*\)::int AS "owners" FROM "trip_members" WHERE "role" = 'owner'/);
      expect(sql[0]).toContain('HAVING COUNT(*) > 1');
      expect(sql[1]).toBe(INDEX);
    });

    it('refuses to run, naming the trips, when a trip already has several owners', async () => {
      const clashes = [{ tripId: 't-1', owners: 2 }, { tripId: 't-2', owners: 3 }];
      const migration = new OneOwnerPerTrip1760200100000();
      const query = jest.fn(async (sql: string) => (sql.trim().startsWith('SELECT') ? clashes : undefined));

      await expect(migration.up({ query } as unknown as QueryRunner)).rejects.toThrow(
        "Can't add UQ_trip_members_one_owner: these trips have more than one owner: t-1 (2 owners), t-2 (3 owners)",
      );
      expect(query).toHaveBeenCalledTimes(1);
    });

    it('down drops the index', async () => {
      expect(await run(new OneOwnerPerTrip1760200100000(), 'down')).toEqual(['DROP INDEX "UQ_trip_members_one_owner"']);
    });

    it('matches the TripMember entity index', () => {
      const index = getMetadataArgsStorage().indices.find(
        (i) => i.target === TripMember && i.name === 'UQ_trip_members_one_owner',
      );

      expect(index).toMatchObject({ columns: ['tripId'], unique: true, where: `"role" = 'owner'` });
    });
  });
});
