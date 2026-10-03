import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddUserForeignKeys1760190000000 } from './1760190000000-add-user-foreign-keys.js';
import { migrations } from './index.js';
import { Trip } from '../../trips/trip.entity.js';
import { TripMember } from '../../app-trips/trip-member.entity.js';
import { TripInvite } from '../../members/trip-invite.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddUserForeignKeys1760190000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

const FKS: [string, string, string, string][] = [
  ['trips', 'ownerUserId', 'FK_trips_ownerUserId', 'RESTRICT'],
  ['trip_members', 'userId', 'FK_trip_members_userId', 'CASCADE'],
  ['trip_invites', 'createdBy', 'FK_trip_invites_createdBy', 'CASCADE'],
  ['trip_invites', 'acceptedBy', 'FK_trip_invites_acceptedBy', 'SET NULL'],
];

describe('AddUserForeignKeys1760190000000', () => {
  it('runs after the users migration and every app-table migration it constrains', () => {
    const names = migrations.map((m) => m.name);
    const at = names.indexOf('AddUserForeignKeys1760190000000');

    expect(at).toBeGreaterThan(-1);
    for (const before of ['CreateUsers1760000000000', 'AppTrips1760100000000', 'CreateTripInvites1760186400000']) {
      expect(names.indexOf(before)).toBeGreaterThan(-1);
      expect(names.indexOf(before)).toBeLessThan(at);
    }
  });

  it('removes rows that point at unknown users before adding the constraints', async () => {
    const sql = await run('up');
    const firstConstraint = sql.findIndex((s) => s.includes('ADD CONSTRAINT'));

    expect(sql.slice(0, firstConstraint)).toEqual([
      'DELETE FROM "trips" t WHERE t."ownerUserId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = t."ownerUserId")',
      'DELETE FROM "trip_members" m WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = m."userId")',
      'DELETE FROM "trip_invites" i WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = i."createdBy")',
      'UPDATE "trip_invites" i SET "acceptedBy" = NULL WHERE i."acceptedBy" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = i."acceptedBy")',
    ]);
    // Bot trips (no owner) are never touched.
    expect(sql[0]).toContain('"ownerUserId" IS NOT NULL');
  });

  it.each(FKS)('adds %s.%s → users as %s ON DELETE %s', async (table, column, name, action) => {
    const sql = (await run('up')).join('\n');

    expect(sql).toContain(`ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "users" ("id") ON DELETE ${action}`);
    expect(sql).toContain(`ALTER TABLE "${table}"`);
  });

  it('never sets trips.ownerUserId to null (CHK_trips_owner would reject it for app trips)', async () => {
    expect((await run('up')).join('\n')).not.toMatch(/"ownerUserId"\) REFERENCES "users" \("id"\) ON DELETE SET NULL/);
  });

  it('drops the four constraints on the way down', async () => {
    const sql = (await run('down')).join('\n');

    for (const [, , name] of FKS) expect(sql).toContain(`DROP CONSTRAINT "${name}"`);
    expect(sql).not.toContain('DELETE');
  });

  it('matches the entity relations', () => {
    const storage = getMetadataArgsStorage();
    const relation = (target: object, property: string) => ({
      onDelete: storage.relations.find((r) => r.target === target && r.propertyName === property)?.options.onDelete,
      join: storage.joinColumns.find((j) => j.target === target && j.propertyName === property),
    });

    expect(relation(Trip, 'owner')).toMatchObject({ onDelete: 'RESTRICT', join: { name: 'ownerUserId', foreignKeyConstraintName: 'FK_trips_ownerUserId' } });
    expect(relation(TripMember, 'user')).toMatchObject({ onDelete: 'CASCADE', join: { name: 'userId', foreignKeyConstraintName: 'FK_trip_members_userId' } });
    expect(relation(TripInvite, 'creator')).toMatchObject({ onDelete: 'CASCADE', join: { name: 'createdBy', foreignKeyConstraintName: 'FK_trip_invites_createdBy' } });
    expect(relation(TripInvite, 'acceptor')).toMatchObject({ onDelete: 'SET NULL', join: { name: 'acceptedBy', foreignKeyConstraintName: 'FK_trip_invites_acceptedBy' } });
  });
});
