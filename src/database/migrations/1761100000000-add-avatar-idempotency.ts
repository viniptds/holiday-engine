import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Profile pictures and idempotent writes (docs/app-profile-offline-spec.md). Existing users keep
 * their Google picture: avatarSource google, googlePictureUrl backfilled from avatarUrl.
 */
export class AddAvatarIdempotency1761100000000 implements MigrationInterface {
  name = 'AddAvatarIdempotency1761100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "avatarSource" text NOT NULL DEFAULT 'google', ADD COLUMN "googlePictureUrl" text, ADD COLUMN "avatarKey" text`);
    await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_avatarSource" CHECK ("avatarSource" IN ('google', 'custom', 'none'))`);
    await queryRunner.query(`UPDATE "users" SET "googlePictureUrl" = "avatarUrl" WHERE "avatarUrl" IS NOT NULL`);
    await queryRunner.query(`
      CREATE TABLE "avatar_uploads" (
        "id" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "objectKey" text NOT NULL,
        "byteSize" integer NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_avatar_uploads_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_avatar_uploads_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_avatar_uploads_status_createdAt" ON "avatar_uploads" ("status", "createdAt")`);
    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "userId" uuid NOT NULL,
        "key" uuid NOT NULL,
        "method" text NOT NULL,
        "path" text NOT NULL,
        "status" smallint NOT NULL DEFAULT 0,
        "responseBody" jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_keys" PRIMARY KEY ("userId", "key"),
        CONSTRAINT "FK_idempotency_keys_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_idempotency_keys_createdAt" ON "idempotency_keys" ("createdAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "avatar_uploads"`);
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_avatarSource"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "avatarKey", DROP COLUMN "googlePictureUrl", DROP COLUMN "avatarSource"`);
  }
}
