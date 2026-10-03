import { MigrationInterface, QueryRunner } from 'typeorm';

/** Provider attempts per user message: every attempt counts toward the AI rate limits. */
export class AddAiMessageAttempts1760400100000 implements MigrationInterface {
  name = 'AddAiMessageAttempts1760400100000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_messages" ADD "attempts" smallint NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE "ai_messages" ADD CONSTRAINT "CHK_ai_messages_attempts" CHECK ("attempts" >= 1)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_messages" DROP CONSTRAINT "CHK_ai_messages_attempts"`);
    await queryRunner.query(`ALTER TABLE "ai_messages" DROP COLUMN "attempts"`);
  }
}
