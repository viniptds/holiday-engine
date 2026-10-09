import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { LLM_PROVIDER } from '../ai/llm/llm-provider.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from '../ai/llm/llm-provider.js';
import { MockLlmProvider } from '../ai/llm/mock-llm.provider.js';
import { AiUnavailableError } from '../ai/llm/llm-provider.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { RateWindow } from '../app-common/rate-window.js';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import { bootMoments, EDITOR, OTHER, OWNER, VIEWER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import { Notification, PushToken } from '../notifications/entities.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PUSH_PROVIDER } from '../notifications/push/push-provider.js';
import { FakeMail, FakePush, expoToken } from '../notifications/testing/fakes.js';
import { ChecklistItem, ChecklistReminder } from './checklist.entities.js';
import { ChecklistService, SUGGESTION_LIMITS } from './checklist.service.js';
import type { ChecklistItemDto, ReminderDto, SuggestionDto } from './checklist.service.js';

/** The mock LLM, recording calls; `fail` makes the next call fail. */
class RecordingLlm implements LlmProvider {
  readonly name = 'mock' as const;
  calls: DraftTurnInput[] = [];
  fail = false;
  private readonly mock = new MockLlmProvider();
  async draftTurn(input: DraftTurnInput): Promise<DraftTurnResult> {
    this.calls.push(input);
    if (this.fail) throw new AiUnavailableError('mock: down');
    return this.mock.draftTurn(input);
  }
}

describe('Trip checklist (feature)', () => {
  const llm = new RecordingLlm();
  const push = new FakePush();
  let h: Harness;

  beforeAll(async () => {
    h = await bootMoments({
      customize: (b) => b.overrideProvider(LLM_PROVIDER).useValue(llm).overrideProvider(PUSH_PROVIDER).useValue(push).overrideProvider(MAIL_TRANSPORT).useValue(new FakeMail()),
    });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.db.clear();
    h.seedUsers();
    llm.calls = [];
    llm.fail = false;
    push.reset();
    Object.assign(h.moduleRef.get(ChecklistService), {
      tripSuggestions: new RateWindow(SUGGESTION_LIMITS.perTrip, SUGGESTION_LIMITS.windowMs, 'trip'),
      userSuggestions: new RateWindow(SUGGESTION_LIMITS.perUser, SUGGESTION_LIMITS.windowMs, 'user'),
    });
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  const team = () => h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);
  const base = (tripId: string) => `/trips/${tripId}/checklist`;
  const add = (tripId: string, user: string, body: Record<string, unknown> = { title: 'Passport' }) => h.json<ChecklistItemDto>('POST', base(tripId), user, body);

  describe('CRUD and roles', () => {
    it('lets owners and editors add, edit, check and delete; viewers read; others get 404', async () => {
      const trip = team();

      const created = await add(trip.id, EDITOR, { title: '  Renew passport ', notes: 'Needs 6 months', priority: 'high', category: 'documents' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ title: 'Renew passport', notes: 'Needs 6 months', priority: 'high', category: 'documents', done: false, source: 'user', createdBy: EDITOR, position: 0 });
      expect((await add(trip.id, OWNER, { title: 'Sunscreen' })).body).toMatchObject({ priority: 'medium', category: 'other', position: 1 });
      expect((await add(trip.id, VIEWER)).status).toBe(403);
      expect((await add(trip.id, OTHER)).status).toBe(404);

      const id = created.body.id;
      const checked = await h.json<ChecklistItemDto>('PATCH', `${base(trip.id)}/${id}`, OWNER, { done: true, notes: null });
      expect(checked.body).toMatchObject({ done: true, doneBy: OWNER, notes: null });
      expect(checked.body.doneAt).toEqual(expect.any(String));
      expect((await h.json<ChecklistItemDto>('PATCH', `${base(trip.id)}/${id}`, EDITOR, { done: false })).body).toMatchObject({ done: false, doneBy: null, doneAt: null });
      expect((await h.json('PATCH', `${base(trip.id)}/${id}`, VIEWER, { done: true })).status).toBe(403);

      const listed = await h.json<{ items: ChecklistItemDto[] }>('GET', base(trip.id), VIEWER);
      expect(listed.body.items.map((i) => i.title)).toEqual(['Renew passport', 'Sunscreen']);
      expect((await h.json('GET', base(trip.id), OTHER)).status).toBe(404);

      expect((await h.call('DELETE', `${base(trip.id)}/${id}`, VIEWER)).status).toBe(403);
      expect((await h.call('DELETE', `${base(trip.id)}/${id}`, EDITOR)).status).toBe(204);
      expect((await h.call('DELETE', `${base(trip.id)}/${id}`, EDITOR)).status).toBe(404);
      expect(h.db.all(ChecklistItem).map((i) => i.title)).toEqual(['Sunscreen']);
    });

    it.each([
      [{ title: '' }],
      [{ title: '   ' }],
      [{ title: 'x'.repeat(121) }],
      [{ title: 'ok', priority: 'urgent' }],
      [{ title: 'ok', category: 'food' }],
      [{ title: 'ok', notes: 'x'.repeat(501) }],
    ])('validates %j', async (body) => {
      const trip = team();
      expect((await add(trip.id, OWNER, body)).status).toBe(400);
    });

    it('notifies nobody when items are added, edited or checked', async () => {
      const trip = team();
      h.db.seed(PushToken, { token: expoToken('owner'), userId: OWNER, platform: 'ios' });
      const item = await add(trip.id, EDITOR);
      await h.json('PATCH', `${base(trip.id)}/${item.body.id}`, EDITOR, { done: true, title: 'Passport!' });

      expect(h.db.all(Notification).filter((n) => n.type !== 'achievement')).toEqual([]);
    });

    it('caps a trip at 200 items (409 CHECKLIST_FULL), bulk adds included, all or nothing', async () => {
      const trip = team();
      for (let i = 0; i < 198; i++) h.db.seed(ChecklistItem, { tripId: trip.id, title: `Item ${i}`, priority: 'low', category: 'other', position: i });

      const bulk = await h.json('POST', `${base(trip.id)}/bulk`, OWNER, { items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] });
      expect(bulk.status).toBe(409);
      expect(bulk.body).toMatchObject({ code: 'CONFLICT', reason: 'CHECKLIST_FULL' });
      expect(h.db.all(ChecklistItem)).toHaveLength(198);

      const ok = await h.json<{ items: ChecklistItemDto[] }>('POST', `${base(trip.id)}/bulk`, EDITOR, { items: [{ title: 'A', priority: 'high', category: 'health' }, { title: 'B' }] });
      expect(ok.status).toBe(201);
      expect(ok.body.items.map((i) => [i.title, i.source, i.position])).toEqual([['A', 'ai', 198], ['B', 'ai', 199]]);
      expect((await add(trip.id, OWNER)).body).toMatchObject({ reason: 'CHECKLIST_FULL' });
      expect((await h.json('POST', `${base(trip.id)}/bulk`, VIEWER, { items: [{ title: 'A' }] })).status).toBe(403);
      expect((await h.json('POST', `${base(trip.id)}/bulk`, OWNER, { items: [] })).status).toBe(400);
    });

    it('reorders with every item exactly once', async () => {
      const trip = team();
      const ids = [];
      for (const title of ['A', 'B', 'C']) ids.push((await add(trip.id, OWNER, { title })).body.id);

      const res = await h.json<{ items: ChecklistItemDto[] }>('PUT', `${base(trip.id)}/order`, EDITOR, { itemIds: [ids[2], ids[0], ids[1]] });
      expect(res.body.items.map((i) => i.title)).toEqual(['C', 'A', 'B']);
      expect((await h.json('PUT', `${base(trip.id)}/order`, EDITOR, { itemIds: [ids[0], ids[1]] })).status).toBe(400);
      expect((await h.json('PUT', `${base(trip.id)}/order`, EDITOR, { itemIds: [ids[0], ids[0], ids[1]] })).status).toBe(400);
      expect((await h.json('PUT', `${base(trip.id)}/order`, EDITOR, { itemIds: [ids[0], ids[1], randomUUID()] })).status).toBe(400);
      expect((await h.json('PUT', `${base(trip.id)}/order`, VIEWER, { itemIds: ids })).status).toBe(403);
    });
  });

  describe('reminders', () => {
    it('are personal, for any member, future only, and sent once to whoever set them', async () => {
      const trip = team();
      h.db.seed(PushToken, { token: expoToken('viewer'), userId: VIEWER, platform: 'ios' });
      h.db.seed(PushToken, { token: expoToken('owner'), userId: OWNER, platform: 'ios' });
      const item = (await add(trip.id, OWNER, { title: 'Passport validity' })).body;
      const soon = new Date(Date.now() + 60_000).toISOString();

      expect((await h.json('PUT', `${base(trip.id)}/${item.id}/reminder`, VIEWER, { remindAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
      expect((await h.json('PUT', `${base(trip.id)}/${item.id}/reminder`, OTHER, { remindAt: soon })).status).toBe(404);
      const set = await h.json<ReminderDto>('PUT', `${base(trip.id)}/${item.id}/reminder`, VIEWER, { remindAt: soon });
      expect(set.body).toEqual({ itemId: item.id, remindAt: soon, sentAt: null });
      expect((await h.json<{ myReminders: ReminderDto[] }>('GET', base(trip.id), VIEWER)).body.myReminders).toHaveLength(1);
      expect((await h.json<{ myReminders: ReminderDto[] }>('GET', base(trip.id), OWNER)).body.myReminders).toEqual([]);

      const service = h.moduleRef.get(NotificationsService);
      await service.run(new Date(Date.now() + 2 * 60_000));
      await service.run(new Date(Date.now() + 3 * 60_000));

      expect(push.to(expoToken('viewer'), 'checklist.reminder')).toEqual(['Review: Passport validity']);
      expect(push.to(expoToken('owner'), 'checklist.reminder')).toEqual([]);
      expect(h.db.all(ChecklistReminder)[0].sentAt).not.toBeNull();
    });

    it('can be replaced (unsent again) and removed', async () => {
      const trip = team();
      const item = (await add(trip.id, OWNER)).body;
      const later = new Date(Date.now() + 3_600_000).toISOString();
      await h.json('PUT', `${base(trip.id)}/${item.id}/reminder`, EDITOR, { remindAt: new Date(Date.now() + 60_000).toISOString() });
      await h.json('PUT', `${base(trip.id)}/${item.id}/reminder`, EDITOR, { remindAt: later });
      expect(h.db.all(ChecklistReminder)).toEqual([expect.objectContaining({ remindAt: new Date(later), sentAt: null })]);

      expect((await h.call('DELETE', `${base(trip.id)}/${item.id}/reminder`, EDITOR)).status).toBe(204);
      expect(h.db.all(ChecklistReminder)).toEqual([]);
    });
  });

  describe('AI suggestions', () => {
    it('returns structured items in the request language, without saving them or touching the AI quota', async () => {
      const trip = team();
      await add(trip.id, OWNER, { title: 'Contratar seguro-viagem' });

      const res = await h.json<{ items: SuggestionDto[] }>('POST', `${base(trip.id)}/suggestions`, EDITOR, undefined, { 'accept-language': 'pt-BR' });

      expect(res.status).toBe(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(5);
      expect(res.body.items[0]).toEqual({ title: 'Verificar a validade do passaporte', notes: 'Muitos países pedem 6 meses de validade.', priority: 'high', category: 'documents' });
      // The existing item isn't suggested again.
      expect(res.body.items.map((i) => i.title)).not.toContain('Contratar seguro-viagem');
      expect(h.db.all(ChecklistItem)).toHaveLength(1);
      expect(h.db.all(AiMessage)).toEqual([]);
      const [call] = llm.calls;
      expect(call.system).toContain('Destination: Lisbon');
      expect(call.system).toContain('Reply language: pt-BR');
      expect(call.history[0].text).toContain('Contratar seguro-viagem');
      expect((await h.json<{ aiQuota: { used: number } }>('GET', '/me', EDITOR)).body.aiQuota.used).toBe(0);
    });

    it('is for owners and editors only', async () => {
      const trip = team();
      expect((await h.json('POST', `${base(trip.id)}/suggestions`, VIEWER)).status).toBe(403);
      expect((await h.json('POST', `${base(trip.id)}/suggestions`, OTHER)).status).toBe(404);
      expect(llm.calls).toEqual([]);
    });

    it('allows 5 a day per trip and 20 a day per user (429 RATE_LIMITED)', async () => {
      const trip = team();
      for (let i = 0; i < 5; i++) expect((await h.call('POST', `${base(trip.id)}/suggestions`, i % 2 ? OWNER : EDITOR)).status).toBe(200);
      const limited = await h.call('POST', `${base(trip.id)}/suggestions`, OWNER);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(80_000);

      const trips = Array.from({ length: 4 }, () => h.seedTrip([[OWNER, 'owner']]));
      let ok = 2; // OWNER used 2 above (the refused call didn't count)
      for (const t of trips) for (let i = 0; i < 5 && ok < 20; i++, ok++) expect((await h.call('POST', `${base(t.id)}/suggestions`, OWNER)).status).toBe(200);
      const fifth = h.seedTrip([[OWNER, 'owner']]);
      expect((await h.call('POST', `${base(fifth.id)}/suggestions`, OWNER)).status).toBe(429);
    });

    it('answers 503 AI_UNAVAILABLE when the model fails', async () => {
      const trip = team();
      llm.fail = true;
      const res = await h.json('POST', `${base(trip.id)}/suggestions`, OWNER);
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ code: 'AI_UNAVAILABLE' });
    });
  });
});
