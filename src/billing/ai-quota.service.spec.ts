import { aiDb } from '../ai/testing/ai-db.js';
import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { AppError } from '../app-common/app-error.js';
import { AiQuotaService } from './ai-quota.service.js';
import type { BillingService } from './billing.service.js';

// The daily quota around DST changes, with an explicit `now` (docs/app-subscriptions-spec.md).

const USER = 'a1111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';

function setup(limit = 2, plus = false) {
  const db = aiDb();
  const billing = { isPlus: async () => plus, freeAiMessagesPerDay: limit } as unknown as BillingService;
  const quota = new AiQuotaService(db.repository(AiConversation) as never, billing);
  const conversation = db.seed(AiConversation, { userId: USER, tripId: null, status: 'open', title: null, updatedAt: new Date('2000-01-01T00:00:00Z') });
  const sendAt = async (iso: string) => {
    db.seed(AiMessage, { conversationId: conversation.id, role: 'user', text: iso, attempts: 1, createdAt: new Date(iso) });
    await db.manager(null).update(AiConversation, { id: conversation.id }, { updatedAt: new Date(iso) });
  };
  const enforce = (zone: string, iso: string) => quota.enforce(db.manager(null) as never, USER, zone, new Date(iso));
  return { quota, sendAt, enforce };
}

const refused = async (promise: Promise<void>) => {
  const error = (await promise.catch((e: unknown) => e)) as AppError | undefined;
  return error instanceof AppError ? { code: error.code, reason: error.reason, resetsAt: error.options.extra?.resetsAt } : 'allowed';
};

describe('AiQuotaService across DST changes', () => {
  it('Europe/Madrid, spring forward (2026-03-29, a 23 h day): resets at local midnight, 22:00Z', async () => {
    const { sendAt, enforce } = setup();
    await sendAt('2026-03-29T08:00:00Z');
    await sendAt('2026-03-29T21:30:00Z'); // 23:30 local, still the 29th

    expect(await refused(enforce('Europe/Madrid', '2026-03-29T21:59:00Z'))).toEqual({
      code: 'PAYMENT_REQUIRED',
      reason: 'AI_QUOTA_EXCEEDED',
      resetsAt: '2026-03-29T22:00:00.000Z',
    });
    expect(await refused(enforce('Europe/Madrid', '2026-03-29T22:00:00Z'))).toBe('allowed');
  });

  it('Pacific/Auckland, clocks back (2026-04-05, a 25 h day): the extra hour is the same day', async () => {
    const { sendAt, enforce } = setup();
    await sendAt('2026-04-04T11:30:00Z'); // 00:30 NZDT on the 5th
    await sendAt('2026-04-05T11:30:00Z'); // 23:30 NZST on the 5th

    expect(await refused(enforce('Pacific/Auckland', '2026-04-05T11:59:00Z'))).toMatchObject({ resetsAt: '2026-04-05T12:00:00.000Z' });
    expect(await refused(enforce('Pacific/Auckland', '2026-04-05T12:00:00Z'))).toBe('allowed');
  });

  it('Pacific/Auckland, spring forward (2026-09-27): yesterday’s messages don’t count', async () => {
    const { sendAt, enforce } = setup();
    await sendAt('2026-09-26T11:59:00Z'); // 23:59 on the 26th
    await sendAt('2026-09-26T11:59:30Z');

    expect(await refused(enforce('Pacific/Auckland', '2026-09-26T12:00:00Z'))).toBe('allowed');
  });

  it('America/Sao_Paulo when DST skipped midnight (2018-11-04): the day starts at 01:00 local', async () => {
    const { sendAt, enforce } = setup();
    await sendAt('2018-11-04T02:59:00Z'); // 23:59 on the 3rd
    await sendAt('2018-11-04T02:59:30Z');

    expect(await refused(enforce('America/Sao_Paulo', '2018-11-04T03:00:00Z'))).toBe('allowed');
    await sendAt('2018-11-04T03:01:00Z');
    await sendAt('2018-11-04T03:02:00Z');
    expect(await refused(enforce('America/Sao_Paulo', '2018-11-04T03:05:00Z'))).toMatchObject({ resetsAt: '2018-11-05T02:00:00.000Z' });
  });

  it('the same messages count for one zone and not for another', async () => {
    const { sendAt, enforce } = setup();
    await sendAt('2026-10-08T22:30:00Z');
    await sendAt('2026-10-08T22:40:00Z');

    // 22:30Z on the 8th is 19:30 that day in São Paulo, but 11:30 on the 9th in Auckland, which is
    // already yesterday when Auckland asks at 00:30 on the 10th (11:30Z on the 9th).
    expect(await refused(enforce('America/Sao_Paulo', '2026-10-08T23:00:00Z'))).not.toBe('allowed');
    expect(await refused(enforce('Pacific/Auckland', '2026-10-09T11:30:00Z'))).toBe('allowed');
  });

  it('status gives limit, used, remaining and the next local midnight; Plus has no limit', async () => {
    const free = setup(10);
    await free.sendAt(new Date(Date.now() - 1000).toISOString());
    expect(await free.quota.status(USER, false, 'UTC')).toMatchObject({ limit: 10, used: 1, remaining: 9 });

    const plus = setup(10, true);
    expect(await plus.quota.status(USER, true, 'UTC')).toMatchObject({ limit: null, remaining: null, used: 0 });
    expect(await refused(plus.enforce('UTC', new Date().toISOString()))).toBe('allowed');
  });
});
