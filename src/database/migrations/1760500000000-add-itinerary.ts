import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Itinerary (docs/app-itinerary-spec.md): an order and an optional start time for trip places, and
 * a version on trips for optimistic concurrency. Existing places get positions by (day, createdAt).
 */
export class AddItinerary1760500000000 implements MigrationInterface {
  name = 'AddItinerary1760500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trip_places"
        ADD COLUMN "position" int NOT NULL DEFAULT 0,
        ADD COLUMN "startTime" time,
        ADD CONSTRAINT "CHK_trip_places_position" CHECK ("position" >= 0)
    `);
    // 0…n-1 within each day of each trip (Unplanned is its own group), oldest first.
    await queryRunner.query(`
      UPDATE "trip_places" p SET "position" = ranked."rank"
      FROM (
        SELECT "id", row_number() OVER (PARTITION BY "tripId", "day" ORDER BY "createdAt", "id") - 1 AS "rank"
        FROM "trip_places"
      ) ranked
      WHERE p."id" = ranked."id"
    `);
    await queryRunner.query(`CREATE INDEX "IDX_trip_places_tripId_day_position" ON "trip_places" ("tripId", "day", "position")`);
    await queryRunner.query(`ALTER TABLE "trips" ADD COLUMN "itineraryVersion" int NOT NULL DEFAULT 0`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trips" DROP COLUMN "itineraryVersion"`);
    await queryRunner.query(`DROP INDEX "IDX_trip_places_tripId_day_position"`);
    await queryRunner.query(`
      ALTER TABLE "trip_places"
        DROP CONSTRAINT "CHK_trip_places_position",
        DROP COLUMN "startTime",
        DROP COLUMN "position"
    `);
  }
}
