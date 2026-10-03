import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Foreign keys from the app tables to `users`, added once both branches meet (gate G1).
 *
 * `trips.ownerUserId` uses ON DELETE RESTRICT, not SET NULL: an app trip has no chat, so a
 * null owner would break CHK_trips_owner and the user delete would fail anyway, with a less clear
 * error. Account deletion hands trips over (or deletes them) first, and users are only
 * soft-deleted, so RESTRICT only stops a hard delete that would orphan trips.
 *
 * App rows written before this migration came from the dev-header stand-in auth and point at
 * users that don't exist; they're removed first, or the constraints couldn't be added.
 */
export class AddUserForeignKeys1760190000000 implements MigrationInterface {
  name = 'AddUserForeignKeys1760190000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const unknownUser = (column: string) => `NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = ${column})`;
    await queryRunner.query(`DELETE FROM "trips" t WHERE t."ownerUserId" IS NOT NULL AND ${unknownUser('t."ownerUserId"')}`);
    await queryRunner.query(`DELETE FROM "trip_members" m WHERE ${unknownUser('m."userId"')}`);
    await queryRunner.query(`DELETE FROM "trip_invites" i WHERE ${unknownUser('i."createdBy"')}`);
    await queryRunner.query(
      `UPDATE "trip_invites" i SET "acceptedBy" = NULL WHERE i."acceptedBy" IS NOT NULL AND ${unknownUser('i."acceptedBy"')}`,
    );

    await queryRunner.query(`
      ALTER TABLE "trips" ADD CONSTRAINT "FK_trips_ownerUserId"
        FOREIGN KEY ("ownerUserId") REFERENCES "users" ("id") ON DELETE RESTRICT
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_members" ADD CONSTRAINT "FK_trip_members_userId"
        FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      ALTER TABLE "trip_invites"
        ADD CONSTRAINT "FK_trip_invites_createdBy" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE CASCADE,
        ADD CONSTRAINT "FK_trip_invites_acceptedBy" FOREIGN KEY ("acceptedBy") REFERENCES "users" ("id") ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_invites"
        DROP CONSTRAINT "FK_trip_invites_acceptedBy",
        DROP CONSTRAINT "FK_trip_invites_createdBy"
    `);
    await queryRunner.query(`ALTER TABLE "trip_members" DROP CONSTRAINT "FK_trip_members_userId"`);
    await queryRunner.query(`ALTER TABLE "trips" DROP CONSTRAINT "FK_trips_ownerUserId"`);
  }
}
