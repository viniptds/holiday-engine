import { jest } from '@jest/globals';
import { QueryRunner } from 'typeorm';
import { CreateLeads1761300000000 } from './1761300000000-create-leads.js';
import { migrations } from './index.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new CreateLeads1761300000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('CreateLeads1761300000000', () => {
  it('runs last, after the home copy migration', () => {
    expect(migrations.at(-1)).toBe(CreateLeads1761300000000);
    expect(migrations.at(-2)?.name).toBe('AddHomeCopy1761200000000');
  });

  it('creates leads with its checks and the converted-user foreign key (SET NULL)', async () => {
    const sql = await run('up');
    expect(sql[0]).toContain('CREATE TABLE "leads"');
    expect(sql[0]).toContain('CONSTRAINT "PK_leads_id" PRIMARY KEY ("id")');
    expect(sql[0]).toContain(`"status" text NOT NULL DEFAULT 'new'`);
    expect(sql[0]).toContain(`CHECK ("kind" IN ('beta', 'contact'))`);
    expect(sql[0]).toContain(`CHECK ("lang" IN ('en', 'pt'))`);
    expect(sql[0]).toContain('FOREIGN KEY ("convertedUserId") REFERENCES "users"("id") ON DELETE SET NULL');
  });

  it('makes the email unique on its lowercased value', async () => {
    expect(await run('up')).toContain('CREATE UNIQUE INDEX "UQ_leads_email_lower" ON "leads" (lower("email"))');
  });

  it('reverts', async () => {
    expect(await run('down')).toEqual(['DROP TABLE "leads"']);
  });
});
