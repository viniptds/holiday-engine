import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUsers1760000000000 implements MigrationInterface {
  name = 'CreateUsers1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "googleSub" text NOT NULL,
        "email" varchar(320) NOT NULL,
        "displayName" varchar(100) NOT NULL,
        "avatarUrl" text,
        "homeCity" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "deletedAt" timestamptz,
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id")
      )
    `);
    // Unique among live users only: a soft-deleted account doesn't block a new sign-up.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_users_googleSub_active" ON "users" ("googleSub") WHERE "deletedAt" IS NULL`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_users_googleSub_active"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
