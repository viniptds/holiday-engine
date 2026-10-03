import { MigrationInterface, QueryRunner } from 'typeorm';

/** Trip invitations. No foreign keys to `users` yet (that table comes with the auth branch). */
export class CreateTripInvites1760186400000 implements MigrationInterface {
  name = 'CreateTripInvites1760186400000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trip_invites" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tripId" uuid NOT NULL,
        "email" varchar(254),
        "tokenHash" varchar(64) NOT NULL,
        "role" text NOT NULL,
        "createdBy" uuid NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "acceptedBy" uuid,
        "acceptedAt" timestamptz,
        "revokedAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trip_invites_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_trip_invites_tokenHash" UNIQUE ("tokenHash"),
        CONSTRAINT "CHK_trip_invites_role" CHECK ("role" IN ('editor', 'viewer')),
        CONSTRAINT "FK_trip_invites_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_trip_invites_tripId" ON "trip_invites" ("tripId")`);
    await queryRunner.query(`CREATE INDEX "IDX_trip_invites_createdBy" ON "trip_invites" ("createdBy")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_trip_invites_createdBy"`);
    await queryRunner.query(`DROP INDEX "IDX_trip_invites_tripId"`);
    await queryRunner.query(`DROP TABLE "trip_invites"`);
  }
}
