import { MigrationInterface, QueryRunner } from 'typeorm';

/** Notifications and the trip checklist (docs/app-notifications-checklist-calendar-spec.md). */
export class AddNotificationsChecklist1761000000000 implements MigrationInterface {
  name = 'AddNotificationsChecklist1761000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "locale" text, ADD COLUMN "notificationPrefs" jsonb`);
    await queryRunner.query(`
      CREATE TABLE "push_tokens" (
        "token" text NOT NULL,
        "userId" uuid NOT NULL,
        "platform" text NOT NULL,
        "deviceId" text,
        "lastSeenAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_tokens_token" PRIMARY KEY ("token"),
        CONSTRAINT "FK_push_tokens_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_push_tokens_userId" ON "push_tokens" ("userId")`);
    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" text NOT NULL,
        "tripId" uuid,
        "title" text NOT NULL,
        "body" text NOT NULL,
        "data" jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "readAt" timestamptz,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notifications_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notifications_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_notifications_userId_createdAt" ON "notifications" ("userId", "createdAt")`);
    await queryRunner.query(`
      CREATE TABLE "notification_jobs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "userId" uuid NOT NULL,
        "type" text NOT NULL,
        "tripId" uuid,
        "itemId" text NOT NULL DEFAULT '',
        "dueAt" timestamptz NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "payload" jsonb,
        "sentAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_jobs_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_notification_jobs_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_notification_jobs_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_notification_jobs_status_dueAt" ON "notification_jobs" ("status", "dueAt")`);
    // One send per (user, type, trip, item, due time); NULL trip ids collide too.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_notification_jobs_key" ON "notification_jobs" ("userId", "type", COALESCE("tripId", '00000000-0000-0000-0000-000000000000'::uuid), "itemId", "dueAt")`,
    );
    await queryRunner.query(`
      CREATE TABLE "push_tickets" (
        "id" text NOT NULL,
        "token" text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_tickets_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "checklist_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "tripId" uuid NOT NULL,
        "title" varchar(120) NOT NULL,
        "notes" varchar(500),
        "priority" text NOT NULL,
        "category" text NOT NULL,
        "done" boolean NOT NULL DEFAULT false,
        "doneBy" uuid,
        "doneAt" timestamptz,
        "position" integer NOT NULL DEFAULT 0,
        "source" text NOT NULL DEFAULT 'user',
        "createdBy" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_checklist_items_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_checklist_items_priority" CHECK ("priority" IN ('high', 'medium', 'low')),
        CONSTRAINT "CHK_checklist_items_category" CHECK ("category" IN ('documents', 'health', 'money', 'packing', 'tech', 'bookings', 'other')),
        CONSTRAINT "CHK_checklist_items_source" CHECK ("source" IN ('ai', 'user')),
        CONSTRAINT "FK_checklist_items_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_checklist_items_doneBy" FOREIGN KEY ("doneBy") REFERENCES "users" ("id") ON DELETE SET NULL,
        CONSTRAINT "FK_checklist_items_createdBy" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_checklist_items_tripId_position" ON "checklist_items" ("tripId", "position")`);
    await queryRunner.query(`
      CREATE TABLE "checklist_reminders" (
        "itemId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "remindAt" timestamptz NOT NULL,
        "sentAt" timestamptz,
        CONSTRAINT "PK_checklist_reminders" PRIMARY KEY ("itemId", "userId"),
        CONSTRAINT "FK_checklist_reminders_itemId" FOREIGN KEY ("itemId") REFERENCES "checklist_items" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_checklist_reminders_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_checklist_reminders_due" ON "checklist_reminders" ("sentAt", "remindAt")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['checklist_reminders', 'checklist_items', 'push_tickets', 'notification_jobs', 'notifications', 'push_tokens']) {
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "notificationPrefs", DROP COLUMN "locale"`);
  }
}
