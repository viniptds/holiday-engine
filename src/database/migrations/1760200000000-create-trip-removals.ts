import { MigrationInterface, QueryRunner } from 'typeorm';

/** Members removed from a trip, so they can't rejoin through a link invite (see `TripRemoval`). */
export class CreateTripRemovals1760200000000 implements MigrationInterface {
  name = 'CreateTripRemovals1760200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trip_removals" (
        "tripId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "removedBy" uuid,
        "removedAt" timestamptz NOT NULL,
        CONSTRAINT "PK_trip_removals" PRIMARY KEY ("tripId", "userId"),
        CONSTRAINT "FK_trip_removals_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_trip_removals_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_trip_removals_removedBy" FOREIGN KEY ("removedBy") REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_trip_removals_userId" ON "trip_removals" ("userId")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_trip_removals_userId"`);
    await queryRunner.query(`DROP TABLE "trip_removals"`);
  }
}
