import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * App trips: user-owned trips with members, alongside the bot's chat-owned trips.
 * No foreign keys to `users` yet (that table comes with the auth branch).
 */
export class AppTrips1760100000000 implements MigrationInterface {
  name = 'AppTrips1760100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trips"
        ADD COLUMN "ownerUserId" uuid,
        ADD COLUMN "travelerProfile" jsonb,
        ADD COLUMN "story" varchar(1000),
        ADD COLUMN "partyType" text,
        ADD COLUMN "partySize" smallint,
        ALTER COLUMN "provider" DROP NOT NULL,
        ALTER COLUMN "chatId" DROP NOT NULL,
        ADD CONSTRAINT "CHK_trips_owner" CHECK (("provider" IS NOT NULL AND "chatId" IS NOT NULL) OR "ownerUserId" IS NOT NULL),
        ADD CONSTRAINT "CHK_trips_partyType" CHECK ("partyType" IN ('solo', 'couple', 'family', 'friends', 'work')),
        ADD CONSTRAINT "CHK_trips_partySize" CHECK ("partySize" BETWEEN 1 AND 20)
    `);
    await queryRunner.query(`
      CREATE TABLE "trip_members" (
        "tripId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "role" text NOT NULL,
        "joinedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trip_members" PRIMARY KEY ("tripId", "userId"),
        CONSTRAINT "CHK_trip_members_role" CHECK ("role" IN ('owner', 'editor', 'viewer')),
        CONSTRAINT "FK_trip_members_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_trip_members_userId" ON "trip_members" ("userId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_trip_members_userId"`);
    await queryRunner.query(`DROP TABLE "trip_members"`);
    // App trips can't satisfy the restored NOT NULL chat columns, so they go.
    await queryRunner.query(`DELETE FROM "trips" WHERE "provider" IS NULL OR "chatId" IS NULL`);
    await queryRunner.query(`
      ALTER TABLE "trips"
        DROP CONSTRAINT "CHK_trips_partySize",
        DROP CONSTRAINT "CHK_trips_partyType",
        DROP CONSTRAINT "CHK_trips_owner",
        ALTER COLUMN "chatId" SET NOT NULL,
        ALTER COLUMN "provider" SET NOT NULL,
        DROP COLUMN "partySize",
        DROP COLUMN "partyType",
        DROP COLUMN "story",
        DROP COLUMN "travelerProfile",
        DROP COLUMN "ownerUserId"
    `);
  }
}
