import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateTrips1759449600000 implements MigrationInterface {
  name = 'CreateTrips1759449600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "trips" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "provider" text NOT NULL,
        "chatId" text NOT NULL,
        "destination" varchar(100) NOT NULL,
        "startDate" date NOT NULL,
        "endDate" date NOT NULL,
        "notes" varchar(500),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trips_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_trips_dates" CHECK ("endDate" >= "startDate")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_trips_provider_chatId" ON "trips" ("provider", "chatId")`);
    await queryRunner.query(`CREATE INDEX "IDX_trips_dates" ON "trips" ("startDate", "endDate")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_trips_dates"`);
    await queryRunner.query(`DROP INDEX "IDX_trips_provider_chatId"`);
    await queryRunner.query(`DROP TABLE "trips"`);
  }
}
