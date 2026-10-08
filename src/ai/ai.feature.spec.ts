import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { AppTripDto, TripRole } from '../app-trips/app-trips.types.js';
import { accessTokens, seedUser } from '../testing/app-testing.js';
import { barrier } from '../testing/in-memory-db.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { aiDb, aiTestingModule } from './testing/ai-db.js';
import { AiConversation } from './entities/ai-conversation.entity.js';
import { AiMessage } from './entities/ai-message.entity.js';
import { TripPlace } from './entities/trip-place.entity.js';
import { AiUnavailableError, LLM_PROVIDER } from './llm/llm-provider.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from './llm/llm-provider.js';
import { MockLlmProvider } from './llm/mock-llm.provider.js';
import { MockPlacesProvider } from './places/mock-places.provider.js';
import { PLACES_PROVIDER } from './places/places-provider.js';
import type { PlaceSearch, PlacesProvider } from './places/places-provider.js';
import type { AiConversationDto, AiTurnDto, TripPlaceDto } from './ai.types.js';

const AUTHOR = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const OTHER = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = '33333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const VIEWER = '44444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS = [AUTHOR, OTHER, EDITOR, VIEWER];
const PROFILE = { email: 'ana.private@example.com', displayName: 'Ana Secret-Surname' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * The mock LLM, plus a script to play first, recording every call. `hold` blocks the call until
 * `release()` (a barrier on the provider call); `held` resolves once it's blocked.
 */
class ScriptedLlm implements LlmProvider {
  readonly name = 'mock' as const;
  private readonly mock = new MockLlmProvider();
  calls: DraftTurnInput[] = [];
  script: ('fail' | 'invalid' | 'hold')[] = [];
  held = deferred();
  private gate = deferred();

  reset() {
    this.calls = [];
    this.script = [];
    this.held = deferred();
    this.gate = deferred();
  }

  release() {
    this.gate.resolve();
  }

  async draftTurn(input: DraftTurnInput): Promise<DraftTurnResult> {
    this.calls.push(input);
    const next = this.script.shift();
    if (next === 'hold') {
      this.held.resolve();
      await this.gate.promise;
    }
    if (next === 'fail') throw new AiUnavailableError('mock: down');
    if (next === 'invalid') return { json: { reply: 42 }, model: 'mock', inputTokens: 5, outputTokens: 1 };
    return this.mock.draftTurn(input);
  }
}

/**
 * Mock places, except that anything called "...Park" resolves far away (so it stays unverified),
 * and Google knows "Lisbon Central Market" by another name.
 */
const mockPlaces = new MockPlacesProvider();
const places: PlacesProvider = {
  name: 'mock',
  searchText: async (search: PlaceSearch) => {
    const match = await mockPlaces.searchText(search);
    if (!match) return match;
    if (search.query.includes('Park')) return { ...match, location: { lat: match.location.lat + 3, lng: match.location.lng } };
    if (search.query.startsWith('Lisbon Central Market')) return { ...match, name: 'Time Out Market Lisboa' };
    return match;
  },
};

describe('AI trip planning API (feature)', () => {
  const db = aiDb();
  const llm = new ScriptedLlm();
  let app: INestApplication;
  let baseUrl: string;
  let tokens: Record<string, string>;
  let deletionHooks: UserDeletionHooks;
  const logged: string[] = [];

  beforeAll(async () => {
    // A high free quota: these tests are about the planner and fair use, not the daily quota (billing specs cover it).
    const moduleRef = await aiTestingModule(db, { FREE_AI_MESSAGES_PER_DAY: '1000' })
      .overrideProvider(LLM_PROVIDER)
      .useValue(llm)
      .overrideProvider(PLACES_PROVIDER)
      .useValue(places)
      .compile();
    tokens = await accessTokens(moduleRef, USERS);
    deletionHooks = moduleRef.get(UserDeletionHooks);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    db.clear();
    for (const id of USERS) seedUser(db, id, id === AUTHOR ? PROFILE : {});
    db.afterRead = undefined;
    db.beforeWrite = undefined;
    llm.reset();
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterEach(() => {
    // A failing double-submit spec must not leave a provider call blocked (the app couldn't close).
    llm.release();
    jest.restoreAllMocks();
  });

  const call = (method: string, path: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function start(message: string, user = AUTHOR, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const response = await call('POST', '/ai/conversations', user, { message, ...extra }, headers);
    return { response, body: (await response.json()) as { conversation: AiConversationDto; turn: AiTurnDto } };
  }

  async function send(id: string, message: string, user = AUTHOR) {
    const response = await call('POST', `/ai/conversations/${id}/messages`, user, { message });
    return { response, body: (await response.json()) as { turn: AiTurnDto } };
  }

  /** A conversation whose latest draft is ready (Lisbon, 2026-11-10 to 2026-11-14). */
  async function readyConversation(user = AUTHOR): Promise<string> {
    const { body } = await start('A trip to Lisbon from 2026-11-10 to 2026-11-14 for 3 people', user);
    expect(body.turn.draft?.ready).toBe(true);
    return body.conversation.id;
  }

  function seedTrip(members: [string, TripRole][] = [[AUTHOR, 'owner']]): Trip {
    const trip = db.seed(Trip, {
      provider: null,
      chatId: null,
      ownerUserId: members[0][0],
      destination: 'Porto',
      startDate: '2026-12-01',
      endDate: '2026-12-03',
      notes: null,
      story: null,
      partyType: null,
      partySize: null,
      travelerProfile: null,
    });
    for (const [userId, role] of members) db.seed(TripMember, { tripId: trip.id, userId, role });
    return trip;
  }

  function seedConversation(userId: string, fields: Partial<AiConversation> = {}): AiConversation {
    return db.seed(AiConversation, { userId, tripId: null, status: 'open', title: null, ...fields });
  }

  function seedUserMessages(conversationId: string, count: number, ageMs: (i: number) => number, attempts = 1) {
    for (let i = 0; i < count; i += 1) {
      db.seed(AiMessage, { conversationId, role: 'user', text: `message ${i}`, createdAt: new Date(Date.now() - ageMs(i)), attempts });
    }
  }

  describe('conversations', () => {
    it('starts a conversation and keeps context across turns until the draft is ready', async () => {
      const first = await start('I want a trip to Lisbon');

      expect(first.response.status).toBe(201);
      expect(first.body.conversation).toMatchObject({ status: 'open', tripId: null, title: 'Lisbon' });
      expect(first.body.turn).toMatchObject({ role: 'assistant', draft: { ready: false, destination: 'Lisbon', startDate: null } });
      expect(first.body.turn.draft!.questions).toEqual(['What are your travel dates?']);

      const second = await send(first.body.conversation.id, 'From 2026-11-10 to 2026-11-14, 3 people');
      expect(second.response.status).toBe(200);
      expect(second.body.turn.draft).toMatchObject({
        ready: true,
        destination: 'Lisbon',
        startDate: '2026-11-10',
        endDate: '2026-11-14',
        partySize: 3,
        questions: [],
      });

      // The model got the earlier turns: the user message and the assistant's JSON.
      const history = llm.calls[1].history;
      expect(history.map((e) => e.role)).toEqual(['user', 'assistant', 'user']);
      expect(JSON.parse(history[1].text)).toMatchObject({ destination: 'Lisbon', reply: first.body.turn.text });

      const detail = await call('GET', `/ai/conversations/${first.body.conversation.id}`, AUTHOR);
      const { turns } = (await detail.json()) as { turns: AiTurnDto[] };
      expect(turns.map((t) => [t.role, t.draft === null])).toEqual([
        ['user', true],
        ['assistant', false],
        ['user', true],
        ['assistant', false],
      ]);
      expect(turns[0].text).toBe('I want a trip to Lisbon');
    });

    it('verifies places: nearby ones get Google data, far ones stay unverified', async () => {
      const { body } = await start('A trip to Lisbon from 2026-11-10 to 2026-11-14');
      const draftPlaces = body.turn.draft!.places;

      expect(draftPlaces.map((p) => [p.name, p.verified])).toEqual([
        ['Lisbon Old Town', true],
        ['Lisbon Central Market', true],
        ['Lisbon City Park', false],
      ]);
      expect(draftPlaces[0].place).toMatchObject({ googlePlaceId: expect.stringMatching(/^mock-/), lat: expect.any(Number) });
      expect(draftPlaces[2].place).toBeNull();
    });

    it('lists only the caller’s conversations, most recently active first', async () => {
      const older = await start('A trip to Rome');
      const newer = await start('A trip to Paris');
      await start('A trip to Oslo', OTHER);
      await send(older.body.conversation.id, 'From 2026-11-10 to 2026-11-12');

      const response = await call('GET', '/ai/conversations', AUTHOR);
      const { conversations } = (await response.json()) as { conversations: AiConversationDto[] };
      expect(conversations.map((c) => c.title)).toEqual(['Rome', 'Paris']);
      expect(conversations.map((c) => c.id)).toEqual([older.body.conversation.id, newer.body.conversation.id]);
    });

    it('lists at most 50', async () => {
      for (let i = 0; i < 55; i += 1) seedConversation(AUTHOR, { title: `Trip ${i}` });
      const { conversations } = (await (await call('GET', '/ai/conversations', AUTHOR)).json()) as { conversations: unknown[] };
      expect(conversations).toHaveLength(50);
    });

    it('replies in the request language', async () => {
      const { body } = await start('Uma viagem para Lisboa', AUTHOR, {}, { 'accept-language': 'pt-BR,pt;q=0.9' });

      expect(llm.calls[0].system).toContain('Reply language: pt-BR');
      expect(body.turn.draft!.questions).toEqual(['Quais são as datas da viagem?']);
    });

    it.each([
      ['an empty message', { message: '   ' }],
      ['a message over 2000 characters', { message: 'x'.repeat(2001) }],
      ['control characters', { message: 'hi\u0000there' }],
      ['an unknown field', { message: 'hi', model: 'gpt-5' }],
      ['a malformed tripId', { message: 'hi', tripId: 'abc' }],
    ])('rejects %s with VALIDATION', async (_label, body) => {
      const response = await call('POST', '/ai/conversations', AUTHOR, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION' });
      expect(llm.calls).toHaveLength(0);
    });

    it('requires sign-in', async () => {
      expect((await call('GET', '/ai/conversations', null)).status).toBe(401);
      expect((await call('POST', '/ai/conversations', null, { message: 'hi' })).status).toBe(401);
    });
  });

  describe('author-only access', () => {
    it.each([
      ['GET', ''],
      ['POST', '/messages'],
      ['POST', '/confirm'],
      ['POST', '/abandon'],
    ])("answers %s %s on someone else's conversation exactly like a missing one", async (method, suffix) => {
      const id = await readyConversation();
      const body = method === 'POST' && suffix !== '/abandon' ? (suffix === '/messages' ? { message: 'hi' } : {}) : undefined;

      const theirs = await call(method, `/ai/conversations/${id}${suffix}`, OTHER, body);
      const missing = await call(method, `/ai/conversations/${randomUUID()}${suffix}`, OTHER, body);
      const malformed = await call(method, `/ai/conversations/not-a-uuid${suffix}`, OTHER, body);

      expect(theirs.status).toBe(404);
      const expected = await missing.json();
      expect(await theirs.json()).toEqual(expected);
      expect(missing.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(db.all(AiConversation)[0].status).toBe('open');
    });

    it("shows a trip-linked conversation to the trip's other members read-only, but not in their own list", async () => {
      const trip = seedTrip([
        [AUTHOR, 'owner'],
        [EDITOR, 'editor'],
      ]);
      const { body } = await start('Add some food places', AUTHOR, { tripId: trip.id });

      const read = await call('GET', `/ai/conversations/${body.conversation.id}`, EDITOR);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ conversation: { id: body.conversation.id }, readOnly: true });
      const own = await call('GET', `/ai/conversations/${body.conversation.id}`, AUTHOR);
      expect(await own.json()).toMatchObject({ readOnly: false });
      const list = (await (await call('GET', '/ai/conversations', EDITOR)).json()) as { conversations: unknown[] };
      expect(list.conversations).toEqual([]);
    });
  });

  describe('state machine and caps', () => {
    it('abandons an open conversation; afterwards it accepts nothing', async () => {
      const id = await readyConversation();

      expect((await call('POST', `/ai/conversations/${id}/abandon`, AUTHOR)).status).toBe(204);
      for (const [path, body] of [
        ['/messages', { message: 'more' }],
        ['/confirm', {}],
        ['/abandon', undefined],
      ] as const) {
        const response = await call('POST', `/ai/conversations/${id}${path}`, AUTHOR, body);
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: 'CONFLICT', reason: 'CONVERSATION_CLOSED' });
      }
      expect(db.all(AiConversation)[0].status).toBe('abandoned');
    });

    it('refuses the 41st user message of a conversation', async () => {
      const conversation = seedConversation(AUTHOR);
      seedUserMessages(conversation.id, 40, (i) => (40 - i) * HOUR * 2);

      const { response, body } = await send(conversation.id, 'one more');
      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'CONFLICT', reason: 'PLAN_FULL' });
      expect(db.all(AiMessage, { conversationId: conversation.id })).toHaveLength(40);
      expect(llm.calls).toHaveLength(0);
    });
  });

  describe('rate limits', () => {
    it('allows 30 messages per rolling hour, then RATE_LIMITED with Retry-After', async () => {
      const conversation = seedConversation(AUTHOR);
      // 30 messages from 50 minutes ago to 21 minutes ago: the oldest leaves the window in 10 minutes.
      seedUserMessages(conversation.id, 30, (i) => (50 - i) * MINUTE);

      const response = await call('POST', '/ai/conversations', AUTHOR, { message: 'A trip to Lisbon' });

      expect(response.status).toBe(429);
      expect(await response.json()).toMatchObject({ code: 'RATE_LIMITED' });
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(9 * 60);
      expect(retryAfter).toBeLessThanOrEqual(10 * 60);
      expect(db.all(AiConversation)).toHaveLength(1);
      expect(llm.calls).toHaveLength(0);
    });

    it('allows 150 messages per rolling 24 hours', async () => {
      // 150 messages between 23 h and 3 h ago (none in the last hour), over four conversations.
      for (let c = 0; c < 4; c += 1) {
        const conversation = seedConversation(AUTHOR);
        seedUserMessages(conversation.id, c < 3 ? 40 : 30, (i) => 23 * HOUR - (c * 40 + i) * 8 * MINUTE);
      }

      const { response } = await start('A trip to Lisbon');

      expect(response.status).toBe(429);
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(59 * 60);
      expect(retryAfter).toBeLessThanOrEqual(60 * 60);
    });

    it("doesn't count old messages or other users' messages", async () => {
      const old = seedConversation(AUTHOR, { updatedAt: new Date(Date.now() - 30 * HOUR) });
      seedUserMessages(old.id, 200, () => 25 * HOUR);
      const theirs = seedConversation(OTHER);
      seedUserMessages(theirs.id, 40, () => MINUTE);

      expect((await start('A trip to Lisbon')).response.status).toBe(201);
    });

    it('counts every attempt, so retried messages weigh more', async () => {
      const conversation = seedConversation(AUTHOR);
      // 10 messages tried 3 times each: 30 attempts in the last hour.
      seedUserMessages(conversation.id, 10, (i) => (40 - i) * MINUTE, 3);

      const response = await call('POST', '/ai/conversations', AUTHOR, { message: 'A trip to Lisbon' });
      expect(response.status).toBe(429);
      // Under 30 once the oldest message (3 attempts, 40 minutes old) leaves the window: in 20 minutes.
      const retryAfter = Number(response.headers.get('retry-after'));
      expect(retryAfter).toBeGreaterThan(19 * 60);
      expect(retryAfter).toBeLessThanOrEqual(20 * 60);
    });

    it('lets exactly the allowed number through when sends race at the limit', async () => {
      const conversation = seedConversation(AUTHOR);
      seedUserMessages(conversation.id, 27, (i) => (50 - i) * MINUTE);
      // Yield after every read, so unserialized requests would all pass the check before any insert.
      db.afterRead = () => new Promise((resolve) => setImmediate(resolve));

      const responses = await Promise.all(
        Array.from({ length: 6 }, (_, i) => call('POST', '/ai/conversations', AUTHOR, { message: `A trip to Rome ${i}` })),
      );

      expect(responses.map((r) => r.status).sort()).toEqual([201, 201, 201, 429, 429, 429]);
      expect(db.all(AiMessage, { role: 'user' }).reduce((n, m) => n + m.attempts, 0)).toBe(30);
    });

    it('counts messages whose reply failed', async () => {
      const conversation = seedConversation(AUTHOR);
      seedUserMessages(conversation.id, 29, () => 5 * MINUTE);
      llm.script = ['fail'];

      expect((await send(conversation.id, 'A trip to Lisbon')).response.status).toBe(503);
      expect((await start('A trip to Rome')).response.status).toBe(429);
    });
  });

  describe('provider failures', () => {
    it('answers AI_UNAVAILABLE, keeps the user message, and lets the same text be retried once stored', async () => {
      const { body } = await start('A trip to Lisbon');
      const id = body.conversation.id;
      llm.script = ['fail'];

      const failed = await send(id, 'From 2026-11-10 to 2026-11-14');
      expect(failed.response.status).toBe(503);
      expect(failed.body).toEqual({ code: 'AI_UNAVAILABLE', message: expect.any(String) });
      expect(JSON.stringify(failed.body)).not.toContain('mock: down');

      const afterFailure = db.all(AiMessage, { conversationId: id });
      expect(afterFailure.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

      const retried = await send(id, 'From 2026-11-10 to 2026-11-14');
      expect(retried.response.status).toBe(200);
      expect(retried.body.turn.draft!.ready).toBe(true);
      expect(db.all(AiMessage, { conversationId: id }).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
      expect(db.all(AiMessage, { conversationId: id, role: 'user' }).map((m) => m.attempts)).toEqual([1, 2]);
    });

    it('merges consecutive user messages when replaying history', async () => {
      const { body } = await start('A trip to Lisbon');
      llm.script = ['fail'];
      await send(body.conversation.id, 'From 2026-11-10');
      await send(body.conversation.id, 'to 2026-11-14');

      expect(llm.calls.at(-1)!.history.map((e) => e.role)).toEqual(['user', 'assistant', 'user']);
      expect(llm.calls.at(-1)!.history[2].text).toBe('From 2026-11-10\n\nto 2026-11-14');
    });

    it('retries an invalid reply once, naming the problem', async () => {
      llm.script = ['invalid'];
      const { response, body } = await start('A trip to Lisbon');

      expect(response.status).toBe(201);
      expect(body.turn.draft!.destination).toBe('Lisbon');
      expect(llm.calls).toHaveLength(2);
      expect(llm.calls[0].system).not.toContain('could not be used');
      expect(llm.calls[1].system).toContain('Your previous reply could not be used (reply:');
      expect(db.all(AiMessage).find((m) => m.role === 'assistant')).toMatchObject({ inputTokens: expect.any(Number), model: 'mock' });
    });

    it('gives up after a second invalid reply', async () => {
      llm.script = ['invalid', 'invalid'];
      const { response } = await start('A trip to Lisbon');

      expect(response.status).toBe(503);
      expect(llm.calls).toHaveLength(2);
      expect(db.all(AiMessage).map((m) => m.role)).toEqual(['user']);
    });

    it('names the new conversation when the first turn fails, so the app can retry there', async () => {
      llm.script = ['fail'];
      const response = await call('POST', '/ai/conversations', AUTHOR, { message: 'A trip to Lisbon' });

      expect(response.status).toBe(503);
      const body = (await response.json()) as { code: string; message: string; conversationId: string };
      const [conversation] = db.all(AiConversation);
      expect(body).toEqual({ code: 'AI_UNAVAILABLE', message: expect.any(String), conversationId: conversation.id });

      const retried = await send(body.conversationId, 'A trip to Lisbon');
      expect(retried.response.status).toBe(200);
      expect(db.all(AiMessage, { role: 'user' })).toEqual([expect.objectContaining({ text: 'A trip to Lisbon', attempts: 2 })]);
    });

    it('allows 3 retries of a failed turn, then CONFLICT', async () => {
      const { body } = await start('A trip to Lisbon');
      const id = body.conversation.id;
      llm.script = ['fail', 'fail', 'fail', 'fail'];

      for (let attempt = 1; attempt <= 4; attempt += 1) {
        expect((await send(id, 'From 2026-11-10 to 2026-11-14')).response.status).toBe(503);
      }
      const [failed] = db.all(AiMessage, { conversationId: id, text: 'From 2026-11-10 to 2026-11-14' });
      expect(failed.attempts).toBe(4);

      const refused = await send(id, 'From 2026-11-10 to 2026-11-14');
      expect(refused.response.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'CONFLICT', reason: 'RETRY_LIMIT' });
      expect(llm.calls).toHaveLength(5);

      // A different message is a new turn.
      expect((await send(id, 'Dates: 2026-11-10 to 2026-11-14')).response.status).toBe(200);
    });
  });

  describe('double submit (BUG-024)', () => {
    const DATES = 'From 2026-11-10 to 2026-11-14';
    const TURN_MARK_MS = 3 * 30_000 + 10_000;

    it('answers a same-text double submit once: one 200, one 409, one provider call, one attempt', async () => {
      const { body } = await start('A trip to Lisbon');
      const id = body.conversation.id;
      llm.reset();
      llm.script = ['hold'];

      const sends = [send(id, DATES), send(id, DATES)];
      await llm.held.promise;

      // While the first reply is being prepared, the second send is refused at once.
      const refused = await Promise.race(sends);
      expect(refused.response.status).toBe(409);
      expect(refused.body).toEqual({ code: 'CONFLICT', reason: 'REPLY_IN_PROGRESS', message: 'A reply is already being prepared' });
      const [pending] = db.all(AiMessage, { conversationId: id, text: DATES });
      expect(pending.attempts).toBe(1);
      const markMs = new Date(pending.replyingUntil!).getTime() - new Date(pending.createdAt).getTime();
      expect(Math.abs(markMs - TURN_MARK_MS)).toBeLessThan(1000);

      llm.release();
      const results = await Promise.all(sends);

      expect(results.map((r) => r.response.status).sort()).toEqual([200, 409]);
      expect(llm.calls).toHaveLength(1);
      expect(db.all(AiMessage, { conversationId: id, text: DATES })).toEqual([
        expect.objectContaining({ attempts: 1, replyingUntil: null }),
      ]);
      expect(db.all(AiMessage, { conversationId: id, role: 'assistant' })).toHaveLength(2);
    });

    it('refuses the same text while a mark is live, without calling the provider or counting an attempt', async () => {
      const conversation = seedConversation(AUTHOR);
      db.seed(AiMessage, { conversationId: conversation.id, role: 'user', text: DATES, replyingUntil: new Date(Date.now() + 60_000) });

      const { response, body } = await send(conversation.id, DATES);

      expect(response.status).toBe(409);
      expect(body).toMatchObject({ code: 'CONFLICT', reason: 'REPLY_IN_PROGRESS' });
      expect(llm.calls).toHaveLength(0);
      expect(db.all(AiMessage)).toEqual([expect.objectContaining({ attempts: 1 })]);
    });

    it('treats an expired mark (the process died mid-reply) as a failed turn: the same text retries', async () => {
      const conversation = seedConversation(AUTHOR);
      db.seed(AiMessage, {
        conversationId: conversation.id,
        role: 'user',
        text: DATES,
        createdAt: new Date(Date.now() - 5 * MINUTE),
        replyingUntil: new Date(Date.now() - 1000),
      });

      const { response } = await send(conversation.id, DATES);

      expect(response.status).toBe(200);
      expect(llm.calls).toHaveLength(1);
      expect(db.all(AiMessage, { role: 'user' })).toEqual([expect.objectContaining({ attempts: 2, replyingUntil: null })]);
    });

    it('clears the mark when the turn fails, so the same text is then a retry', async () => {
      const { body } = await start('A trip to Lisbon');
      const id = body.conversation.id;
      llm.script = ['fail'];

      expect((await send(id, DATES)).response.status).toBe(503);
      expect(db.all(AiMessage, { conversationId: id, text: DATES })).toEqual([
        expect.objectContaining({ attempts: 1, replyingUntil: null }),
      ]);

      expect((await send(id, DATES)).response.status).toBe(200);
      expect(db.all(AiMessage, { conversationId: id, text: DATES })).toEqual([
        expect.objectContaining({ attempts: 2, replyingUntil: null }),
      ]);
    });

    it('marks and clears the first message of a conversation too', async () => {
      llm.script = ['hold'];
      const starting = call('POST', '/ai/conversations', AUTHOR, { message: 'A trip to Lisbon' });
      await llm.held.promise;
      const [first] = db.all(AiMessage);
      expect(first.replyingUntil).toEqual(expect.any(Date));

      const again = await send(first.conversationId, 'A trip to Lisbon');
      expect(again.response.status).toBe(409);

      llm.release();
      expect((await starting).status).toBe(201);
      expect(db.all(AiMessage, { role: 'user' })).toEqual([expect.objectContaining({ attempts: 1, replyingUntil: null })]);
    });
  });

  describe('confirm', () => {
    it('gives a new trip the persona of answers the traveler clearly stated, and none otherwise', async () => {
      const stated = await start('A relaxed trip to Lisbon from 2026-11-10 to 2026-11-14 for 2 people');
      expect(stated.body.turn.draft).toMatchObject({ ready: true, travelerAnswers: { pace: ['slow'] } });
      expect(llm.calls[0].system).toContain('pace (');

      const confirmed = await call('POST', `/ai/conversations/${stated.body.conversation.id}/confirm`, AUTHOR, {}, { 'accept-language': 'pt-BR' });
      expect(confirmed.status).toBe(201);
      const trip = (await confirmed.json()) as AppTripDto;
      expect(trip.travelerProfile).toEqual({ questionSetVersion: expect.any(Number), answers: { pace: ['slow'] }, persona: expect.any(String) });
      // Stored as the persona key, like the wizard does.
      expect(db.all(Trip, { id: trip.id })[0].travelerProfile).toMatchObject({ answers: { pace: ['slow'] }, persona: 'relaxer' });

      const unstated = await start('A trip to Porto from 2026-11-10 to 2026-11-14');
      expect(unstated.body.turn.draft!.travelerAnswers).toEqual({});
      const plain = (await (await call('POST', `/ai/conversations/${unstated.body.conversation.id}/confirm`, AUTHOR, {})).json()) as AppTripDto;
      expect(plain.travelerProfile).toBeNull();
    });

    it("leaves a linked trip's traveler profile alone", async () => {
      const trip = seedTrip([[AUTHOR, 'owner']]);
      const { body } = await start('A relaxed day of places in Porto', AUTHOR, { tripId: trip.id });

      expect((await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, AUTHOR, {})).status).toBe(200);
      expect(db.all(Trip, { id: trip.id })[0].travelerProfile).toBeNull();
    });

    it('refuses a draft that is not ready', async () => {
      const { body } = await start('A trip to Lisbon');
      const response = await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, AUTHOR, {});
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'CONFLICT', reason: 'DRAFT_NOT_READY' });
      expect(db.all(Trip)).toHaveLength(0);
    });

    it('creates the trip with its verified places only, and is idempotent', async () => {
      const id = await readyConversation();

      const response = await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {});
      expect(response.status).toBe(201);
      const trip = (await response.json()) as AppTripDto;
      expect(trip).toMatchObject({
        destination: 'Lisbon',
        startDate: '2026-11-10',
        endDate: '2026-11-14',
        partySize: 3,
        myRole: 'owner',
        memberCount: 1,
      });

      const placesResponse = await call('GET', `/trips/${trip.id}/places`, AUTHOR);
      const { places: saved } = (await placesResponse.json()) as { places: TripPlaceDto[] };
      // Verified places are saved under Google's name; the AI's reason becomes the notes.
      expect(saved.map((p) => [p.name, p.day, p.source])).toEqual([
        ['Lisbon Old Town', 1, 'ai'],
        ['Time Out Market Lisboa', 1, 'ai'],
      ]);
      expect(saved[1]).toMatchObject({ googlePlaceId: expect.stringMatching(/^mock-/), notes: 'Local food in one place.' });
      expect(db.all(AiConversation)[0]).toMatchObject({ status: 'confirmed', tripId: trip.id });

      const again = await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {});
      expect(again.status).toBe(200);
      expect(((await again.json()) as AppTripDto).id).toBe(trip.id);
      expect(db.all(Trip)).toHaveLength(1);
      expect(db.all(TripPlace)).toHaveLength(2);

      const closed = await send(id, 'one more thing');
      expect(closed.response.status).toBe(409);
      expect(closed.body).toMatchObject({ reason: 'CONVERSATION_CLOSED' });
    });

    it('rolls everything back when saving the places fails', async () => {
      const id = await readyConversation();
      db.beforeWrite = (operation, entity) => {
        if (operation === 'insert' && entity === TripPlace) throw new Error('disk full');
      };

      const failed = await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {});
      expect(failed.status).toBe(500);
      expect(db.all(Trip)).toHaveLength(0);
      expect(db.all(TripMember)).toHaveLength(0);
      expect(db.all(AiConversation)[0].status).toBe('open');

      db.beforeWrite = undefined;
      expect((await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {})).status).toBe(201);
    });

    it('creates one trip when two confirms race', async () => {
      const id = await readyConversation();
      const sync = barrier(2);
      db.afterRead = async (entity) => {
        if (entity === AiMessage) await sync();
      };

      const responses = await Promise.all([
        call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {}),
        call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {}),
      ]);

      expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
      const [a, b] = (await Promise.all(responses.map((r) => r.json()))) as AppTripDto[];
      expect(a.id).toBe(b.id);
      expect(db.all(Trip)).toHaveLength(1);
      expect(db.all(TripPlace)).toHaveLength(2);
    });

    it('applies the trip rules again on confirm', async () => {
      const conversation = seedConversation(AUTHOR);
      db.seed(AiMessage, {
        conversationId: conversation.id,
        role: 'assistant',
        text: 'ok',
        draft: {
          ready: true,
          destination: 'Lisbon',
          startDate: '2026-11-14',
          endDate: '2026-11-10',
          partyType: null,
          partySize: null,
          story: null,
          places: [],
          questions: [],
        },
      });

      const response = await call('POST', `/ai/conversations/${conversation.id}/confirm`, AUTHOR, {});
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'VALIDATION', fields: { endDate: expect.any(String) } });
      expect(db.all(Trip)).toHaveLength(0);
    });

    it('rejects a body with fields', async () => {
      const id = await readyConversation();
      expect((await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, { destination: 'Rome' })).status).toBe(400);
    });
  });

  describe('trip-linked conversations', () => {
    it('needs owner or editor to start, and non-members get NOT_FOUND', async () => {
      const trip = seedTrip([
        [AUTHOR, 'owner'],
        [EDITOR, 'editor'],
        [VIEWER, 'viewer'],
      ]);

      expect((await start('Add places', VIEWER, { tripId: trip.id })).response.status).toBe(403);
      expect((await start('Add places', OTHER, { tripId: trip.id })).response.status).toBe(404);
      const { response, body } = await start('Add places', EDITOR, { tripId: trip.id });
      expect(response.status).toBe(201);
      expect(body.conversation).toMatchObject({ tripId: trip.id, title: 'Porto' });
      expect(llm.calls.at(-1)!.system).toContain('existing trip: Porto, 2026-12-01 to 2026-12-03');
      expect(body.turn.draft).toMatchObject({ ready: true, destination: 'Porto', startDate: '2026-12-01', endDate: '2026-12-03' });
    });

    it('adds only places on confirm (200), leaving the trip unchanged and skipping places it already has', async () => {
      const trip = seedTrip([
        [AUTHOR, 'owner'],
        [EDITOR, 'editor'],
      ]);
      const { body } = await start('Places to visit in Porto', EDITOR, { tripId: trip.id });
      const existing = body.turn.draft!.places[0].place!;
      db.seed(TripPlace, {
        tripId: trip.id,
        googlePlaceId: existing.googlePlaceId,
        name: 'Already there',
        category: 'sight',
        day: null,
        notes: null,
        address: existing.address,
        lat: existing.lat,
        lng: existing.lng,
        rating: null,
        mapsUrl: null,
        types: [],
        source: 'user',
        createdBy: AUTHOR,
      });

      const response = await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, EDITOR, {});

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: trip.id, destination: 'Porto', myRole: 'editor' });
      expect(db.all(Trip)).toHaveLength(1);
      expect(db.all(TripPlace, { tripId: trip.id }).map((p) => p.name).sort()).toEqual(['Already there', 'Porto Central Market']);
    });

    it("returns the trip's persona label in the request's language on confirm, like every Trip response", async () => {
      const trip = seedTrip([[AUTHOR, 'owner']]);
      await db.manager(null).update(Trip, { id: trip.id }, {
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] }, persona: 'relaxer' },
      });
      const { body } = await start('Places to visit in Porto', AUTHOR, { tripId: trip.id }, { 'accept-language': 'pt-BR' });
      const personaOf = async (response: Response) => ((await response.json()) as AppTripDto).travelerProfile?.persona;

      const confirmed = await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, AUTHOR, {}, { 'accept-language': 'pt-BR' });
      const again = await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, AUTHOR, {}, { 'accept-language': 'es' });

      expect(confirmed.status).toBe(200);
      const pt = await personaOf(confirmed);
      expect(pt).toBe(await personaOf(await call('GET', `/trips/${trip.id}`, AUTHOR, undefined, { 'accept-language': 'pt-BR' })));
      expect(pt).not.toBe(await personaOf(await call('GET', `/trips/${trip.id}`, AUTHOR, undefined, { 'accept-language': 'en' })));
      // The idempotent second confirm answers in its own request's language.
      expect(await personaOf(again)).toBe(await personaOf(await call('GET', `/trips/${trip.id}`, AUTHOR, undefined, { 'accept-language': 'es' })));
      expect(pt).toEqual(expect.any(String));
    });

    it('checks the role again at confirm time', async () => {
      const trip = seedTrip([
        [AUTHOR, 'owner'],
        [EDITOR, 'editor'],
      ]);
      const { body } = await start('Ideas', EDITOR, { tripId: trip.id });
      await db.manager(null).update(TripMember, { tripId: trip.id, userId: EDITOR }, { role: 'viewer' });

      const response = await call('POST', `/ai/conversations/${body.conversation.id}/confirm`, EDITOR, {});
      expect(response.status).toBe(403);
      expect(db.all(TripPlace)).toHaveLength(0);
      expect(db.all(AiConversation)[0].status).toBe('open');
    });
  });

  describe('trip places', () => {
    async function confirmedTrip(): Promise<string> {
      const id = await readyConversation();
      const trip = (await (await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {})).json()) as AppTripDto;
      db.seed(TripMember, { tripId: trip.id, userId: EDITOR, role: 'editor' });
      db.seed(TripMember, { tripId: trip.id, userId: VIEWER, role: 'viewer' });
      return trip.id;
    }

    it('lets members read places, owners and editors delete them', async () => {
      const tripId = await confirmedTrip();
      const [place] = db.all(TripPlace);

      expect((await call('GET', `/trips/${tripId}/places`, VIEWER)).status).toBe(200);
      expect((await call('GET', `/trips/${tripId}/places`, OTHER)).status).toBe(404);
      expect((await call('DELETE', `/trips/${tripId}/places/${place.id}`, VIEWER)).status).toBe(403);
      expect((await call('DELETE', `/trips/${tripId}/places/${place.id}`, EDITOR)).status).toBe(204);
      expect((await call('DELETE', `/trips/${tripId}/places/${place.id}`, EDITOR)).status).toBe(404);
      expect((await call('DELETE', `/trips/${tripId}/places/nope`, EDITOR)).status).toBe(404);
      expect(db.all(TripPlace)).toHaveLength(1);
    });

    it("can't delete another trip's place through this trip", async () => {
      const tripId = await confirmedTrip();
      const other = seedTrip([[AUTHOR, 'owner']]);
      const [place] = db.all(TripPlace, { tripId });
      expect((await call('DELETE', `/trips/${other.id}/places/${place.id}`, AUTHOR)).status).toBe(404);
    });

    it('go with their trip', async () => {
      const tripId = await confirmedTrip();
      expect(db.all(TripPlace)).toHaveLength(2);
      expect((await call('DELETE', `/trips/${tripId}`, AUTHOR)).status).toBe(204);
      expect(db.all(TripPlace)).toHaveLength(0);
    });
  });

  describe('account deletion', () => {
    it("deletes the user's conversations and keeps their places on the trip", async () => {
      const id = await readyConversation();
      await call('POST', `/ai/conversations/${id}/confirm`, AUTHOR, {});
      await start('A trip to Rome', OTHER);

      await deletionHooks.run(AUTHOR);

      expect(db.all(AiConversation).map((c) => c.userId)).toEqual([OTHER]);
      expect(db.all(AiMessage).every((m) => db.all(AiConversation, { id: m.conversationId }).length === 1)).toBe(true);
      expect(db.all(TripPlace)).toHaveLength(2);
      expect(db.all(TripPlace).every((p) => p.createdBy === null)).toBe(true);
    });
  });

  describe('privacy', () => {
    it('never sends the user’s name or email to the provider, and never logs message text', async () => {
      const id = await readyConversation();
      await send(id, 'Something about my secret anniversary');
      llm.script = ['fail'];
      await send(id, 'Another private detail');

      const payloads = JSON.stringify(llm.calls);
      expect(payloads).not.toContain(PROFILE.email);
      expect(payloads).not.toContain('Secret-Surname');
      expect(payloads).not.toContain(AUTHOR);

      const logs = logged.join('\n');
      expect(logs).toContain(`conversation=${id}`);
      expect(logs).toMatch(/provider=mock model=mock inputTokens=\d+ outputTokens=\d+/);
      for (const secret of ['secret anniversary', 'private detail', 'Lisbon from', PROFILE.email]) {
        expect(logs).not.toContain(secret);
      }
    });
  });
});
