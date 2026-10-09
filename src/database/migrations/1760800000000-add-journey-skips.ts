import { MigrationInterface, QueryRunner } from 'typeorm';

/** Skipped Journey steps per trip (docs/app-trip-detail-v2-spec.md): unique (tripId, key). */
export class AddJourneySkips1760800000000 implements MigrationInterface {
  name = 'AddJourneySkips1760800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trip_journey_skips" (
        "tripId" uuid NOT NULL,
        "key" text NOT NULL,
        "skippedBy" uuid,
        "skippedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trip_journey_skips" PRIMARY KEY ("tripId", "key"),
        CONSTRAINT "FK_trip_journey_skips_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_trip_journey_skips_skippedBy" FOREIGN KEY ("skippedBy") REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trip_journey_skips"`);
  }
}
