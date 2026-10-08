import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Holid.ai Plus (docs/app-subscriptions-spec.md): the user's time zone, their store entitlements
 * (the source of truth for "is Plus"), and the RevenueCat webhook events already applied
 * (idempotency on the event id).
 */
export class AddBilling1760600000000 implements MigrationInterface {
  name = 'AddBilling1760600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "timezone" text`);
    await queryRunner.query(`
      CREATE TABLE "user_entitlements" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "entitlement" text NOT NULL,
        "store" text NOT NULL,
        "productId" text,
        "status" text NOT NULL,
        "expiresAt" timestamptz,
        "willRenew" boolean,
        "lastEventId" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_user_entitlements_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_entitlements_userId_entitlement" UNIQUE ("userId", "entitlement"),
        CONSTRAINT "CHK_user_entitlements_store" CHECK ("store" IN ('app_store', 'play_store', 'promotional', 'dev')),
        CONSTRAINT "CHK_user_entitlements_status" CHECK ("status" IN ('active', 'grace', 'expired')),
        CONSTRAINT "FK_user_entitlements_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "billing_events" (
        "eventId" text NOT NULL,
        "type" text NOT NULL,
        "appUserId" text,
        "processedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_billing_events_eventId" PRIMARY KEY ("eventId")
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "billing_events"`);
    await queryRunner.query(`DROP TABLE "user_entitlements"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "timezone"`);
  }
}
