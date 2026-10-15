import { MigrationInterface, QueryRunner } from 'typeorm';

/** Web lead capture (docs/web-leads-spec.md): `leads`, the incomplete users, unique on the lowercased email. */
export class CreateLeads1761300000000 implements MigrationInterface {
  name = 'CreateLeads1761300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "leads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying(320) NOT NULL,
        "name" character varying(80),
        "kind" text NOT NULL,
        "role" character varying(80),
        "message" text,
        "lang" text NOT NULL,
        "source" character varying(32) NOT NULL,
        "utm" jsonb,
        "ipHash" character varying(64) NOT NULL,
        "userAgent" character varying(300),
        "status" text NOT NULL DEFAULT 'new',
        "convertedUserId" uuid,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_leads_id" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_leads_kind" CHECK ("kind" IN ('beta', 'contact')),
        CONSTRAINT "CHK_leads_lang" CHECK ("lang" IN ('en', 'pt')),
        CONSTRAINT "CHK_leads_status" CHECK ("status" IN ('new', 'invited', 'converted', 'unsubscribed')),
        CONSTRAINT "FK_leads_convertedUserId" FOREIGN KEY ("convertedUserId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_leads_email_lower" ON "leads" (lower("email"))`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "leads"`);
  }
}
