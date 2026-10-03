import { MigrationInterface, QueryRunner } from 'typeorm';

/** AI trip planning: conversations, their messages, and the places saved on trips. */
export class CreateAiTables1760400000000 implements MigrationInterface {
  name = 'CreateAiTables1760400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ai_conversations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "tripId" uuid,
        "status" text NOT NULL,
        "title" varchar(100),
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_conversations_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_ai_conversations_status" CHECK ("status" IN ('open', 'confirmed', 'abandoned')),
        CONSTRAINT "FK_ai_conversations_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_ai_conversations_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_conversations_userId_updatedAt" ON "ai_conversations" ("userId", "updatedAt" DESC)`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_ai_conversations_tripId" ON "ai_conversations" ("tripId")`);

    await queryRunner.query(`
      CREATE TABLE "ai_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conversationId" uuid NOT NULL,
        "role" text NOT NULL,
        "text" text NOT NULL,
        "draft" jsonb,
        "provider" text,
        "model" text,
        "inputTokens" integer,
        "outputTokens" integer,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ai_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_ai_messages_role" CHECK ("role" IN ('user', 'assistant')),
        CONSTRAINT "FK_ai_messages_conversationId" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_ai_messages_conversationId_createdAt" ON "ai_messages" ("conversationId", "createdAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "trip_places" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tripId" uuid NOT NULL,
        "googlePlaceId" text NOT NULL,
        "name" varchar(200) NOT NULL,
        "category" text NOT NULL,
        "day" smallint,
        "notes" varchar(500),
        "address" text NOT NULL,
        "lat" double precision NOT NULL,
        "lng" double precision NOT NULL,
        "rating" real,
        "mapsUrl" text,
        "types" text[] NOT NULL DEFAULT '{}',
        "source" text NOT NULL,
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_trip_places_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_trip_places_tripId_googlePlaceId" UNIQUE ("tripId", "googlePlaceId"),
        CONSTRAINT "CHK_trip_places_category" CHECK ("category" IN ('food', 'sight', 'nature', 'nightlife', 'shopping', 'activity', 'stay', 'other')),
        CONSTRAINT "CHK_trip_places_day" CHECK ("day" >= 1),
        CONSTRAINT "CHK_trip_places_source" CHECK ("source" IN ('ai', 'user')),
        CONSTRAINT "FK_trip_places_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_trip_places_createdBy" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trip_places"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_messages_conversationId_createdAt"`);
    await queryRunner.query(`DROP TABLE "ai_messages"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_conversations_tripId"`);
    await queryRunner.query(`DROP INDEX "IDX_ai_conversations_userId_updatedAt"`);
    await queryRunner.query(`DROP TABLE "ai_conversations"`);
  }
}
