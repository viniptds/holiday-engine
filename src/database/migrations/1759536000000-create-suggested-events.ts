import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateSuggestedEvents1759536000000 implements MigrationInterface {
  name = 'CreateSuggestedEvents1759536000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "suggested_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tripId" uuid NOT NULL,
        "externalId" text NOT NULL,
        "sentAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_suggested_events_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_suggested_events_tripId_externalId" UNIQUE ("tripId", "externalId"),
        CONSTRAINT "FK_suggested_events_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "suggested_events"`);
  }
}
