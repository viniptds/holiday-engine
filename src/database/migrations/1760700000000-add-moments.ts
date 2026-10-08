import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Moments, achievements and the destination's country/city (docs/app-moments-spec.md):
 * `moments`, `user_achievements` (unique per user, key and trip, NULL trip ids equal) and
 * `trips.countryCode` / `trips.cityPlaceId`.
 */
export class AddMoments1760700000000 implements MigrationInterface {
  name = 'AddMoments1760700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "trips" ADD COLUMN "countryCode" varchar(2), ADD COLUMN "cityPlaceId" text`);
    await queryRunner.query(`
      CREATE TABLE "moments" (
        "id" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "tripId" uuid,
        "status" text NOT NULL,
        "objectKey" text NOT NULL,
        "contentType" text NOT NULL,
        "byteSize" integer NOT NULL,
        "width" integer NOT NULL,
        "height" integer NOT NULL,
        "takenAt" timestamptz NOT NULL,
        "takenOn" date NOT NULL,
        "lat" double precision,
        "lng" double precision,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "completedAt" timestamptz,
        CONSTRAINT "PK_moments_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_moments_status" CHECK ("status" IN ('pending', 'ready')),
        CONSTRAINT "CHK_moments_byteSize" CHECK ("byteSize" BETWEEN 1 AND 10485760),
        CONSTRAINT "FK_moments_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_moments_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_moments_tripId_status" ON "moments" ("tripId", "status")`);
    await queryRunner.query(`CREATE INDEX "IDX_moments_userId" ON "moments" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_moments_status_createdAt" ON "moments" ("status", "createdAt")`);
    await queryRunner.query(`
      CREATE TABLE "user_achievements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "key" text NOT NULL,
        "tripId" uuid,
        "unlockedAt" timestamptz NOT NULL DEFAULT now(),
        "seenAt" timestamptz,
        CONSTRAINT "PK_user_achievements_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_achievements_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_achievements_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_user_achievements_userId" ON "user_achievements" ("userId")`);
    // NULL trip ids (per-user keys) must collide too, so the index is on an expression.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_user_achievements_user_key_trip" ON "user_achievements" ("userId", "key", COALESCE("tripId", '00000000-0000-0000-0000-000000000000'::uuid))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "user_achievements"`);
    await queryRunner.query(`DROP TABLE "moments"`);
    await queryRunner.query(`ALTER TABLE "trips" DROP COLUMN "cityPlaceId", DROP COLUMN "countryCode"`);
  }
}
