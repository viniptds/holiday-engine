import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { AddBilling1760600000000 } from './1760600000000-add-billing.js';
import { migrations } from './index.js';
import { UserEntitlement } from '../../billing/user-entitlement.entity.js';
import { BillingEvent } from '../../billing/billing-event.entity.js';
import { User } from '../../users/user.entity.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down'): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await new AddBilling1760600000000()[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('AddBilling1760600000000', () => {
  it('runs after the users table and the itinerary', () => {
    const names = migrations.map((m) => m.name);
    expect(names.indexOf('AddBilling1760600000000')).toBeGreaterThan(names.indexOf('AddItinerary1760500000000'));
    expect(names.indexOf('CreateUsers1760000000000')).toBeGreaterThan(-1);
  });

  it('adds users.timezone, user_entitlements and billing_events', async () => {
    const [timezone, entitlements, events] = await run('up');

    expect(timezone).toBe('ALTER TABLE "users" ADD COLUMN "timezone" text');
    for (const part of [
      'CREATE TABLE "user_entitlements"',
      '"expiresAt" timestamptz,',
      '"willRenew" boolean,',
      '"lastEventId" text,',
      'CONSTRAINT "UQ_user_entitlements_userId_entitlement" UNIQUE ("userId", "entitlement")',
      `CONSTRAINT "CHK_user_entitlements_store" CHECK ("store" IN ('app_store', 'play_store', 'promotional', 'dev'))`,
      `CONSTRAINT "CHK_user_entitlements_status" CHECK ("status" IN ('active', 'grace', 'expired'))`,
      'CONSTRAINT "FK_user_entitlements_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE',
    ]) {
      expect(entitlements).toContain(part);
    }
    expect(events).toContain('CONSTRAINT "PK_billing_events_eventId" PRIMARY KEY ("eventId")');
  });

  it('reverts everything', async () => {
    expect(await run('down')).toEqual(['DROP TABLE "billing_events"', 'DROP TABLE "user_entitlements"', 'ALTER TABLE "users" DROP COLUMN "timezone"']);
  });

  it('matches the entities', async () => {
    const [, entitlements] = await run('up');
    const storage = getMetadataArgsStorage();
    for (const check of storage.checks.filter((c) => c.target === UserEntitlement)) {
      expect(entitlements).toContain(`CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    }
    expect(storage.uniques.find((u) => u.target === UserEntitlement)?.columns).toEqual(['userId', 'entitlement']);
    expect(storage.relations.find((r) => r.target === UserEntitlement && r.propertyName === 'user')?.options.onDelete).toBe('CASCADE');
    expect(storage.columns.find((c) => c.target === User && c.propertyName === 'timezone')?.options).toMatchObject({ type: 'text', nullable: true });
    expect(storage.columns.find((c) => c.target === BillingEvent && c.propertyName === 'eventId')?.options).toMatchObject({ type: 'text' });
  });
});
