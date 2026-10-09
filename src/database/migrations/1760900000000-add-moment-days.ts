import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moment source and day (docs/app-trip-overview-spec.md). Existing moments are camera photos:
 * their day is backfilled from the local date they were taken on ("takenOn", the uploader's zone),
 * relative to their trip's start, and stays null outside the trip or without one.
 */
export class AddMomentDays1760900000000 implements MigrationInterface {
  name = 'AddMomentDays1760900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "moments" ADD COLUMN "source" text NOT NULL DEFAULT 'camera', ADD COLUMN "day" smallint`);
    await queryRunner.query(`ALTER TABLE "moments" ADD CONSTRAINT "CHK_moments_source" CHECK ("source" IN ('camera', 'upload'))`);
    await queryRunner.query(`ALTER TABLE "moments" ADD CONSTRAINT "CHK_moments_day" CHECK ("day" >= 1)`);
    await queryRunner.query(`
      UPDATE "moments" m SET "day" = (m."takenOn" - t."startDate") + 1
      FROM "trips" t
      WHERE m."tripId" = t."id" AND m."status" = 'ready' AND m."takenOn" BETWEEN t."startDate" AND t."endDate"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "moments" DROP CONSTRAINT "CHK_moments_day", DROP CONSTRAINT "CHK_moments_source"`);
    await queryRunner.query(`ALTER TABLE "moments" DROP COLUMN "day", DROP COLUMN "source"`);
  }
}
