import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { bootMoments, EDITOR, OTHER, OWNER, VIEWER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import { AiConversation } from './entities/ai-conversation.entity.js';
import { AiMessage } from './entities/ai-message.entity.js';
import type { AiConversationDto, AiTurnDto, TripAiConversationDto } from './ai.types.js';

type Started = { conversation: AiConversationDto; turn: AiTurnDto };

describe('Shared AI history on trips (feature)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootMoments();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.db.clear();
    h.seedUsers();
    for (const level of ['log', 'warn', 'debug'] as const) jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  async function start(user: string, tripId?: string, message = 'Add some food places'): Promise<Started> {
    const res = await h.json<Started>('POST', '/ai/conversations', user, { message, ...(tripId ? { tripId } : {}) });
    expect(res.status).toBe(201);
    return res.body;
  }

  it("lets every member of the linked trip read the conversation, read-only", async () => {
    const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);
    const { conversation } = await start(EDITOR, trip.id);

    for (const member of [OWNER, VIEWER]) {
      const res = await h.json<{ conversation: AiConversationDto; turns: AiTurnDto[]; readOnly: boolean }>('GET', `/ai/conversations/${conversation.id}`, member);
      expect(res.status).toBe(200);
      expect(res.body.readOnly).toBe(true);
      expect(res.body.turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    }
    expect((await h.json<{ readOnly: boolean }>('GET', `/ai/conversations/${conversation.id}`, EDITOR)).body.readOnly).toBe(false);
  });

  it.each([
    ['POST', '/messages', { message: 'more please' }],
    ['POST', '/confirm', {}],
    ['POST', '/abandon', undefined],
  ])('answers a non-author member 403 NOT_CONVERSATION_AUTHOR on %s %s, changing nothing', async (method, suffix, body) => {
    const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
    const { conversation } = await start(EDITOR, trip.id);
    const messages = h.db.all(AiMessage).length;

    const res = await h.json(method, `/ai/conversations/${conversation.id}${suffix}`, OWNER, body);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN', reason: 'NOT_CONVERSATION_AUTHOR' });
    expect(h.db.all(AiConversation)[0].status).toBe('open');
    expect(h.db.all(AiMessage)).toHaveLength(messages);
  });

  it('lists the trip\'s linked conversations from every author, newest first, with the author and readOnly', async () => {
    const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
    const elsewhere = h.seedTrip([[OWNER, 'owner']]);
    const first = await start(OWNER, trip.id, 'Museums please');
    const second = await start(EDITOR, trip.id, 'Food please');
    await start(OWNER, elsewhere.id);
    await start(OWNER);
    // Distinct creation times, oldest first.
    await h.db.repository(AiConversation).update({ id: first.conversation.id }, { createdAt: new Date(Date.now() - 60_000) });

    const res = await h.json<{ conversations: TripAiConversationDto[] }>('GET', `/trips/${trip.id}/ai/conversations`, OWNER);

    expect(res.status).toBe(200);
    expect(res.body.conversations.map((c) => [c.id, c.author, c.readOnly])).toEqual([
      [second.conversation.id, { userId: EDITOR, displayName: 'Traveler 2222', avatarUrl: null, role: 'editor' }, true],
      [first.conversation.id, { userId: OWNER, displayName: 'Traveler 1111', avatarUrl: null, role: 'owner' }, false],
    ]);
    expect((await h.json('GET', `/trips/${trip.id}/ai/conversations`, OTHER)).status).toBe(404);
  });

  it('removes access at once when a member is removed (404), and shows a departed author with no role', async () => {
    const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor'], [VIEWER, 'viewer']]);
    const { conversation } = await start(EDITOR, trip.id);

    expect((await h.call('DELETE', `/trips/${trip.id}/members/${VIEWER}`, OWNER)).status).toBe(204);
    expect((await h.json('GET', `/ai/conversations/${conversation.id}`, VIEWER)).status).toBe(404);
    expect((await h.json('GET', `/trips/${trip.id}/ai/conversations`, VIEWER)).status).toBe(404);

    // The author leaves: the conversation stays with the trip, and the author still sees their own.
    expect((await h.call('DELETE', `/trips/${trip.id}/members/me`, EDITOR)).status).toBe(204);
    const list = await h.json<{ conversations: TripAiConversationDto[] }>('GET', `/trips/${trip.id}/ai/conversations`, OWNER);
    expect(list.body.conversations[0].author).toMatchObject({ userId: EDITOR, role: null });
    expect((await h.json<{ readOnly: boolean }>('GET', `/ai/conversations/${conversation.id}`, EDITOR)).body.readOnly).toBe(false);
  });

  it('keeps unlinked conversations private to their author, and other trips\' out of reach', async () => {
    h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
    const other = h.seedTrip([[OTHER, 'owner']]);
    const unlinked = await start(OWNER);
    const foreign = await start(OTHER, other.id);

    expect((await h.json('GET', `/ai/conversations/${unlinked.conversation.id}`, EDITOR)).status).toBe(404);
    expect((await h.json('POST', `/ai/conversations/${unlinked.conversation.id}/messages`, EDITOR, { message: 'hi' })).status).toBe(404);
    expect((await h.json('GET', `/ai/conversations/${foreign.conversation.id}`, OWNER)).status).toBe(404);
  });

  it('a confirmed new-trip plan becomes linked to its trip, so the members who join can read it', async () => {
    const started = await start(OWNER, undefined, 'A trip to Lisbon from 2026-11-10 to 2026-11-14 for 3 people');
    expect(started.turn.draft?.ready).toBe(true);
    const confirmed = await h.json<{ id: string }>('POST', `/ai/conversations/${started.conversation.id}/confirm`, OWNER, {});
    expect(confirmed.status).toBe(201);
    h.db.seed(TripMember, { tripId: confirmed.body.id, userId: VIEWER, role: 'viewer' });

    expect((await h.json<{ readOnly: boolean }>('GET', `/ai/conversations/${started.conversation.id}`, VIEWER)).body.readOnly).toBe(true);
  });
});
