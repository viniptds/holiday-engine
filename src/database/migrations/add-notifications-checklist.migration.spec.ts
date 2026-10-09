import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddNotificationsChecklist1761000000000 } from './1761000000000-add-notifications-checklist.js';
import { migrations } from './index.js';
import { ChecklistItem } from '../../checklist/checklist.entities.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddNotificationsChecklist1761000000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddNotificationsChecklist1761000000000', () => {
  it('runs last', () => {
    expect(migrations.at(-1)).toBe(AddNotificationsChecklist1761000000000);
  });

  it('creates the tables with the idempotency key and the entity checks', async () => {
    const sql = (await run('up')).join('\n');
    expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "locale" text, ADD COLUMN "notificationPrefs" jsonb');
    expect(sql).toContain(
      `CREATE UNIQUE INDEX "UQ_notification_jobs_key" ON "notification_jobs" ("userId", "type", COALESCE("tripId", '00000000-0000-0000-0000-000000000000'::uuid), "itemId", "dueAt")`,
    );
    expect(sql).toContain('CONSTRAINT "PK_checklist_reminders" PRIMARY KEY ("itemId", "userId")');
    for (const check of getMetadataArgsStorage().checks.filter((c) => c.target === ChecklistItem)) expect(sql).toContain(`CONSTRAINT "${check.name}" CHECK (${check.expression})`);
  });

  it('reverts', async () => {
    const down = await run('down');
    expect(down.at(-1)).toBe('ALTER TABLE "users" DROP COLUMN "notificationPrefs", DROP COLUMN "locale"');
    expect(down).toContain('DROP TABLE "checklist_items"');
  });
});
