import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * At most one owner per trip, enforced by the database (the services keep exactly one). Refuses to
 * run, listing the trips, if existing data already has a trip with several owners: which one stays
 * owner is a decision for a person, not a migration.
 */
export class OneOwnerPerTrip1760200100000 implements MigrationInterface {
  name = 'OneOwnerPerTrip1760200100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const clashes: { tripId: string; owners: number }[] = await queryRunner.query(`
      SELECT "tripId", COUNT(*)::int AS "owners" FROM "trip_members"
      WHERE "role" = 'owner' GROUP BY "tripId" HAVING COUNT(*) > 1
    `);
    if (clashes.length > 0) {
      const list = clashes.map((c) => `${c.tripId} (${c.owners} owners)`).join(', ');
      throw new Error(`Can't add UQ_trip_members_one_owner: these trips have more than one owner: ${list}`);
    }
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_trip_members_one_owner" ON "trip_members" ("tripId") WHERE "role" = 'owner'`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_trip_members_one_owner"`);
  }
}
