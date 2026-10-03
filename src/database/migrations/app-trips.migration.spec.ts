import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AppTrips1760100000000 } from './1760100000000-app-trips.js';
import { migrations } from './index.js';
import { Trip } from '../../trips/trip.entity.js';
import { TripMember } from '../../app-trips/trip-member.entity.js';
import { PARTY_TYPES, MAX_PARTY_SIZE, MIN_PARTY_SIZE, TRIP_ROLES } from '../../app-trips/app-trips.types.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AppTrips1760100000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

const quoted = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

describe('AppTrips1760100000000', () => {
  it('runs after the migrations it builds on', () => {
    const names = migrations.map((m) => m.name);

    expect(names.indexOf('AppTrips1760100000000')).toBeGreaterThan(names.indexOf('CreateSuggestedEvents1759536000000'));
  });

  it('adds the app columns as nullable and relaxes the chat columns', async () => {
    const [alter] = await run('up');

    expect(alter).toContain('ALTER TABLE "trips"');
    for (const column of [
      'ADD COLUMN "ownerUserId" uuid,',
      'ADD COLUMN "travelerProfile" jsonb,',
      'ADD COLUMN "story" varchar(1000),',
      'ADD COLUMN "partyType" text,',
      'ADD COLUMN "partySize" smallint,',
      'ALTER COLUMN "provider" DROP NOT NULL',
      'ALTER COLUMN "chatId" DROP NOT NULL',
    ]) {
      expect(alter).toContain(column);
    }
    expect(alter).not.toMatch(/ADD COLUMN [^,]*NOT NULL/);
  });

  it('requires a chat or an owning user, and bounds partyType and partySize', async () => {
    const [alter] = await run('up');

    expect(alter).toContain(
      'ADD CONSTRAINT "CHK_trips_owner" CHECK (("provider" IS NOT NULL AND "chatId" IS NOT NULL) OR "ownerUserId" IS NOT NULL)',
    );
    expect(alter).toContain(`ADD CONSTRAINT "CHK_trips_partyType" CHECK ("partyType" IN (${quoted(PARTY_TYPES)}))`);
    expect(alter).toContain(
      `ADD CONSTRAINT "CHK_trips_partySize" CHECK ("partySize" BETWEEN ${MIN_PARTY_SIZE} AND ${MAX_PARTY_SIZE})`,
    );
  });

  it('creates trip_members with a composite key, a role check, a cascading FK to trips and a userId index', async () => {
    const [, create, index] = await run('up');

    expect(create).toContain('CREATE TABLE "trip_members"');
    expect(create).toContain('"joinedAt" timestamptz NOT NULL DEFAULT now()');
    expect(create).toContain('CONSTRAINT "PK_trip_members" PRIMARY KEY ("tripId", "userId")');
    expect(create).toContain(`CONSTRAINT "CHK_trip_members_role" CHECK ("role" IN (${quoted(TRIP_ROLES)}))`);
    expect(create).toContain(
      'CONSTRAINT "FK_trip_members_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE',
    );
    // No FK to users yet: that table comes with the auth branch.
    expect(create).not.toContain('"users"');
    expect(index).toBe('CREATE INDEX "IDX_trip_members_userId" ON "trip_members" ("userId")');
  });

  it('reverts everything, dropping app trips before restoring NOT NULL', async () => {
    const sql = await run('down');

    expect(sql.slice(0, 3)).toEqual([
      'DROP INDEX "IDX_trip_members_userId"',
      'DROP TABLE "trip_members"',
      'DELETE FROM "trips" WHERE "provider" IS NULL OR "chatId" IS NULL',
    ]);
    for (const part of [
      'DROP CONSTRAINT "CHK_trips_owner"',
      'DROP CONSTRAINT "CHK_trips_partyType"',
      'DROP CONSTRAINT "CHK_trips_partySize"',
      'ALTER COLUMN "chatId" SET NOT NULL',
      'ALTER COLUMN "provider" SET NOT NULL',
      'DROP COLUMN "ownerUserId"',
      'DROP COLUMN "travelerProfile"',
      'DROP COLUMN "story"',
      'DROP COLUMN "partyType"',
      'DROP COLUMN "partySize"',
    ]) {
      expect(sql[3]).toContain(part);
    }
  });

  // Keeps the entities in sync with the migration, so DB_SYNCHRONIZE=true and migrations agree.
  it('matches the Trip entity checks and columns', async () => {
    const [alter] = await run('up');
    const storage = getMetadataArgsStorage();
    const checks = storage.checks.filter((c) => c.target === Trip);
    const columns = new Map(storage.columns.filter((c) => c.target === Trip).map((c) => [c.propertyName, c.options]));

    for (const name of ['CHK_trips_owner', 'CHK_trips_partyType', 'CHK_trips_partySize']) {
      const check = checks.find((c) => c.name === name);
      expect(check).toBeDefined();
      expect(alter).toContain(`ADD CONSTRAINT "${name}" CHECK (${check!.expression})`);
    }
    expect(columns.get('provider')).toMatchObject({ type: 'text', nullable: true });
    expect(columns.get('chatId')).toMatchObject({ type: 'text', nullable: true });
    expect(columns.get('ownerUserId')).toMatchObject({ type: 'uuid', nullable: true });
    expect(columns.get('travelerProfile')).toMatchObject({ type: 'jsonb', nullable: true });
    expect(columns.get('story')).toMatchObject({ type: 'varchar', length: 1000, nullable: true });
    expect(columns.get('partyType')).toMatchObject({ type: 'text', nullable: true });
    expect(columns.get('partySize')).toMatchObject({ type: 'smallint', nullable: true });
  });

  it('matches the TripMember entity key, check, index and relation', async () => {
    const [, create] = await run('up');
    const storage = getMetadataArgsStorage();
    const primary = storage.columns.filter((c) => c.target === TripMember && c.mode === 'regular' && c.options.primary);
    const check = storage.checks.find((c) => c.target === TripMember);
    // UQ_trip_members_one_owner comes later, from OneOwnerPerTrip1760200100000 (its own spec).
    const indexes = storage.indices
      .filter((i) => i.target === TripMember && i.name !== 'UQ_trip_members_one_owner')
      .map((i) => [i.name, i.columns]);
    const relation = storage.relations.find((r) => r.target === TripMember && r.propertyName === 'trip');
    const joinColumn = storage.joinColumns.find((j) => j.target === TripMember && j.propertyName === 'trip');

    expect(primary.map((c) => [c.propertyName, c.options.primaryKeyConstraintName])).toEqual([
      ['tripId', 'PK_trip_members'],
      ['userId', 'PK_trip_members'],
    ]);
    expect(create).toContain(`CONSTRAINT "${check!.name}" CHECK (${check!.expression})`);
    expect(indexes).toEqual([['IDX_trip_members_userId', ['userId']]]);
    expect(relation?.options.onDelete).toBe('CASCADE');
    expect(joinColumn).toMatchObject({ name: 'tripId', foreignKeyConstraintName: 'FK_trip_members_tripId' });
  });
});
