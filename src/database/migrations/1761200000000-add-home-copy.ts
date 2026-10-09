import { MigrationInterface, QueryRunner } from 'typeorm';

/** Home tab (docs/app-home-spec.md): the shared, AI-refreshed banner copy with its 7-day expiry. */
export class AddHomeCopy1761200000000 implements MigrationInterface {
  name = 'AddHomeCopy1761200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "home_copy" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "destinationId" text NOT NULL,
        "tier" text NOT NULL,
        "locale" text NOT NULL,
        "angle" text NOT NULL DEFAULT '',
        "variants" jsonb NOT NULL,
        "model" text,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_home_copy_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_home_copy_destination_tier_locale_angle" ON "home_copy" ("destinationId", "tier", "locale", "angle")`);
    await queryRunner.query(`CREATE INDEX "IDX_home_copy_expiresAt" ON "home_copy" ("expiresAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "home_copy"`);
  }
}
