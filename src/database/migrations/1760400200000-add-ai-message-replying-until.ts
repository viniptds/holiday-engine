import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * In-flight mark on user messages (BUG-024): set while their provider call runs, so a second send
 * of the same text isn't taken for a retry of a failed turn. It expires on its own if the process dies.
 */
export class AddAiMessageReplyingUntil1760400200000 implements MigrationInterface {
  name = 'AddAiMessageReplyingUntil1760400200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_messages" ADD "replyingUntil" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_messages" DROP COLUMN "replyingUntil"`);
  }
}
