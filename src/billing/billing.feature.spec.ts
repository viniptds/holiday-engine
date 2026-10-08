import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { INestApplication, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { TestingModule } from '@nestjs/testing';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { TripRole } from '../app-trips/app-trips.types.js';
import { User } from '../users/user.entity.js';
import { localDayBounds } from '../app-common/timezone.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';
import { aiDb } from '../ai/testing/ai-db.js';
import { AiModule } from '../ai/ai.module.js';
import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { MOCK_CENTER } from '../ai/places/mock-places.provider.js';
import { BillingModule } from './billing.module.js';
import { devBillingModule } from './dev-billing.module.js';
import { BillingService } from './billing.service.js';
import { BillingEvent } from './billing-event.entity.js';
import { UserEntitlement } from './user-entitlement.entity.js';
import { BILLING_PROVIDER } from './revenuecat.js';
import type { RevenueCatSubscriber } from './revenuecat.js';
import type { RevenueCatEvent } from './entitlement-state.js';

// docs/app-subscriptions-spec.md, Tests (engine). RevenueCat REST is a fake: no real calls.

const ALICE = 'a1111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const BOB = 'b2222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const EDITOR = 'c3333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
const USERS = [ALICE, BOB, EDITOR];
const WEBHOOK_AUTH = 'Bearer whsec-test-value-123';
const DAY = 86_400_000;

/** The REST API: a mutable answer, or a failure. `name` decides revenuecat vs mock behaviour. */
const rest = {
  name: 'revenuecat' as 'revenuecat' | 'mock',
  getSubscriber: jest.fn(async (_id: string): Promise<RevenueCatSubscriber | null> => {
    throw new Error('RevenueCat subscriber lookup failed: HTTP 503');
  }),
};

describe('Holid.ai Plus (feature)', () => {
  const db = aiDb();
  let app: INestApplication;
  let baseUrl: string;
  let tokens: Record<string, string>;
  let moduleRef: TestingModule;
  const env = { DEV_LOGIN_ENABLED: process.env.DEV_LOGIN_ENABLED };

  async function build(devLogin: boolean) {
    if (devLogin) process.env.DEV_LOGIN_ENABLED = 'true';
    else delete process.env.DEV_LOGIN_ENABLED;
    let builder = appTestingModule(db, [AiModule, BillingModule, devBillingModule()], {
      REVENUECAT_WEBHOOK_AUTH: WEBHOOK_AUTH,
      FREE_AI_MESSAGES_PER_DAY: '10',
      FREE_TRIP_PLACES_LIMIT: '15',
    });
    for (const entity of [AiConversation, AiMessage, TripPlace]) {
      builder = builder.overrideProvider(getRepositoryToken(entity)).useValue(db.repository(entity as never));
    }
    return builder.overrideProvider(BILLING_PROVIDER).useValue(rest).compile();
  }

  beforeAll(async () => {
    moduleRef = await build(true);
    tokens = await accessTokens(moduleRef, USERS);
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = `${await app.getUrl()}/app/v1`;
  });

  afterAll(async () => {
    await app?.close();
    if (env.DEV_LOGIN_ENABLED === undefined) delete process.env.DEV_LOGIN_ENABLED;
    else process.env.DEV_LOGIN_ENABLED = env.DEV_LOGIN_ENABLED;
  });

  const logs: string[] = [];
  beforeEach(() => {
    db.clear();
    for (const id of USERS) seedUser(db, id, { email: `${id.slice(0, 5)}@private.example` });
    rest.name = 'revenuecat';
    rest.getSubscriber.mockReset();
    rest.getSubscriber.mockRejectedValue(new Error('RevenueCat subscriber lookup failed: HTTP 503'));
    (moduleRef.get(BillingService) as unknown as { syncs: Map<string, number[]> }).syncs.clear();
    logs.length = 0;
    jest.restoreAllMocks();
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
  });

  const call = (method: string, path: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json = async <T = Record<string, unknown>>(response: Response) => (await response.json()) as T;
  const entitlement = (userId: string) => db.all(UserEntitlement, { userId })[0];
  const grantPlus = (userId: string, fields: Partial<UserEntitlement> = {}) =>
    db.seed(UserEntitlement, { userId, entitlement: 'plus', store: 'app_store', productId: 'm', status: 'active', expiresAt: new Date(Date.now() + 30 * DAY), willRenew: true, ...fields });

  const webhook = (event: Partial<RevenueCatEvent>, auth: string | null = WEBHOOK_AUTH) =>
    fetch(`${baseUrl}/billing/revenuecat-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
      body: JSON.stringify({ api_version: '1.0', event: { id: randomUUID(), entitlement_ids: ['plus'], store: 'APP_STORE', product_id: 'ai.holid.app.plus.monthly', ...event } }),
    });
  // Fixed per test file run, so expiries compare exactly (whole seconds, as RevenueCat sends ms of whole seconds).
  const BASE = Math.floor(Date.now() / 1000) * 1000;
  const inDays = (days: number) => BASE + days * DAY;

  describe('webhook auth', () => {
    it.each([
      ['missing', null],
      ['wrong', 'Bearer whsec-test-value-124'],
      ['a prefix of the right one', 'Bearer whsec-test'],
    ])('refuses a %s Authorization with 401, applies nothing and never logs the value', async (_label, auth) => {
      const response = await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) }, auth);

      expect(response.status).toBe(401);
      expect((await json(response)).code).toBe('UNAUTHENTICATED');
      expect(db.all(UserEntitlement)).toEqual([]);
      expect(logs.join('\n')).toContain('RevenueCat webhook refused');
      expect(logs.join('\n')).not.toContain('whsec');
    });
  });

  describe('webhook events (REST failing → the event data is kept)', () => {
    it.each(['INITIAL_PURCHASE', 'RENEWAL', 'PRODUCT_CHANGE', 'UNCANCELLATION', 'NON_RENEWING_PURCHASE'])('%s gives Plus', async (type) => {
      const response = await webhook({ type, app_user_id: ALICE, expiration_at_ms: inDays(30), new_product_id: 'ai.holid.app.plus.yearly' });

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ result: 'applied' });
      expect(entitlement(ALICE)).toMatchObject({ status: 'active', store: 'app_store', willRenew: type !== 'NON_RENEWING_PURCHASE' });
      expect(await moduleRef.get(BillingService).isPlus(ALICE)).toBe(true);
      expect(logs.join('\n')).toContain('keeping the webhook data');
    });

    it('CANCELLATION keeps Plus until it expires, BILLING_ISSUE moves to grace, EXPIRATION ends it', async () => {
      await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      await webhook({ type: 'CANCELLATION', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      expect(entitlement(ALICE)).toMatchObject({ status: 'active', willRenew: false });

      await webhook({ type: 'BILLING_ISSUE', app_user_id: ALICE, expiration_at_ms: inDays(30), grace_period_expiration_at_ms: inDays(46) });
      expect(entitlement(ALICE)).toMatchObject({ status: 'grace', expiresAt: new Date(inDays(46)) });
      expect(await moduleRef.get(BillingService).isPlus(ALICE)).toBe(true);

      await webhook({ type: 'EXPIRATION', app_user_id: ALICE, expiration_at_ms: inDays(46) });
      expect(entitlement(ALICE)).toMatchObject({ status: 'expired' });
      expect(await moduleRef.get(BillingService).isPlus(ALICE)).toBe(false);
    });

    it('SUBSCRIPTION_PAUSED changes nothing; TEST and unknown types answer 200 and store nothing', async () => {
      await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      const before = { ...entitlement(ALICE) };

      expect(await json(await webhook({ type: 'SUBSCRIPTION_PAUSED', app_user_id: ALICE }))).toEqual({ result: 'applied' });
      expect(entitlement(ALICE)).toMatchObject({ status: before.status, expiresAt: before.expiresAt });
      const events = db.all(BillingEvent).length;

      expect(await json(await webhook({ type: 'TEST', app_user_id: ALICE }))).toEqual({ result: 'test' });
      expect(await json(await webhook({ type: 'SUBSCRIBER_ALIAS', app_user_id: ALICE }))).toEqual({ result: 'ignored' });
      expect(db.all(BillingEvent)).toHaveLength(events);
    });

    it('is idempotent on the event id', async () => {
      const id = randomUUID();
      await webhook({ id, type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      await webhook({ type: 'EXPIRATION', app_user_id: ALICE, expiration_at_ms: inDays(30) });

      const again = await webhook({ id, type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });

      expect(await json(again)).toEqual({ result: 'duplicate' });
      expect(entitlement(ALICE).status).toBe('expired');
      expect(db.all(BillingEvent, { eventId: id })).toHaveLength(1);
    });

    it('never moves the expiry backwards and ignores a late EXPIRATION of an older period', async () => {
      await webhook({ type: 'RENEWAL', app_user_id: ALICE, expiration_at_ms: inDays(60) });
      await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      expect(entitlement(ALICE).expiresAt).toEqual(new Date(inDays(60)));

      await webhook({ type: 'EXPIRATION', app_user_id: ALICE, expiration_at_ms: inDays(30) });
      expect(entitlement(ALICE)).toMatchObject({ status: 'active', expiresAt: new Date(inDays(60)) });
    });

    it('TRANSFER moves the entitlement between the two app user ids', async () => {
      await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });

      const response = await webhook({ type: 'TRANSFER', app_user_id: null, transferred_from: [ALICE], transferred_to: [BOB] });

      expect(await json(response)).toEqual({ result: 'applied' });
      expect(entitlement(ALICE)).toMatchObject({ status: 'expired', willRenew: false });
      expect(entitlement(BOB)).toMatchObject({ status: 'active', expiresAt: new Date(inDays(30)), store: 'app_store' });
    });

    it.each([
      ['an unknown user id', randomUUID()],
      ['a non-uuid app user id', '$RCAnonymousID:abc'],
    ])('ignores %s: 200, warning, nothing created', async (_label, appUserId) => {
      const response = await webhook({ type: 'INITIAL_PURCHASE', app_user_id: appUserId, expiration_at_ms: inDays(30) });

      expect(await json(response)).toEqual({ result: 'ignored' });
      expect(db.all(UserEntitlement)).toEqual([]);
      expect(db.all(BillingEvent)).toEqual([]);
      expect(logs.join('\n')).toContain('unknown app user id');
    });

    it('ignores events of another entitlement', async () => {
      expect(await json(await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, entitlement_ids: ['pro'] }))).toEqual({ result: 'ignored' });
      expect(db.all(UserEntitlement)).toEqual([]);
    });

    it('rejects a body that is not an event', async () => {
      const response = await fetch(`${baseUrl}/billing/revenuecat-webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: WEBHOOK_AUTH },
        body: JSON.stringify({ hello: 'world' }),
      });
      expect(response.status).toBe(400);
    });
  });

  describe('webhook then REST re-read (the source of truth)', () => {
    it('stores what REST says over the event data', async () => {
      rest.getSubscriber.mockResolvedValue({
        entitlements: { plus: { expires_date: new Date(inDays(365)).toISOString(), product_identifier: 'ai.holid.app.plus.yearly' } },
        subscriptions: { 'ai.holid.app.plus.yearly': { store: 'app_store', unsubscribe_detected_at: new Date().toISOString() } },
      });

      await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });

      expect(rest.getSubscriber).toHaveBeenCalledWith(ALICE);
      expect(entitlement(ALICE)).toMatchObject({
        status: 'active',
        productId: 'ai.holid.app.plus.yearly',
        expiresAt: new Date(inDays(365)),
        willRenew: false,
      });
    });

    it('expires an entitlement REST no longer has', async () => {
      grantPlus(ALICE);
      rest.getSubscriber.mockResolvedValue({ entitlements: {}, subscriptions: {} });

      await webhook({ type: 'CANCELLATION', app_user_id: ALICE, expiration_at_ms: inDays(30) });

      expect(entitlement(ALICE).status).toBe('expired');
    });
  });

  describe('POST /subscription/sync', () => {
    it('re-reads the caller from RevenueCat and returns the plan', async () => {
      rest.getSubscriber.mockResolvedValue({
        entitlements: { plus: { expires_date: new Date(inDays(30)).toISOString(), product_identifier: 'm' } },
        subscriptions: { m: { store: 'play_store' } },
      });

      const response = await call('POST', '/subscription/sync', ALICE);

      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({
        plan: { tier: 'plus', status: 'active', expiresAt: new Date(inDays(30)).toISOString(), willRenew: true, store: 'play_store' },
      });
      expect(rest.getSubscriber).toHaveBeenCalledWith(ALICE);
    });

    it('is 503 BILLING_UNAVAILABLE when RevenueCat fails, and the stored plan stays', async () => {
      grantPlus(ALICE);

      const response = await call('POST', '/subscription/sync', ALICE);

      expect(response.status).toBe(503);
      expect((await json(response)).code).toBe('BILLING_UNAVAILABLE');
      expect(entitlement(ALICE).status).toBe('active');
    });

    it('with the mock provider reads only the local table', async () => {
      rest.name = 'mock';
      grantPlus(ALICE);

      expect(await json(await call('POST', '/subscription/sync', ALICE))).toMatchObject({ plan: { tier: 'plus' } });
      expect(rest.getSubscriber).not.toHaveBeenCalled();
      expect(await json(await call('POST', '/subscription/sync', BOB))).toEqual({
        plan: { tier: 'free', status: null, expiresAt: null, willRenew: null, store: null },
      });
    });

    it('allows 20 per user per hour (RATE_LIMITED with Retry-After)', async () => {
      rest.name = 'mock';
      for (let i = 0; i < 20; i += 1) expect((await call('POST', '/subscription/sync', ALICE)).status).toBe(200);

      const limited = await call('POST', '/subscription/sync', ALICE);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3500);
      expect((await call('POST', '/subscription/sync', BOB)).status).toBe(200);
    });

    it('needs a session', async () => {
      expect((await call('POST', '/subscription/sync', null)).status).toBe(401);
    });
  });

  describe('dev-grant (dev login rules)', () => {
    it('flips the caller’s own plan', async () => {
      const plus = await call('POST', '/subscription/dev-grant', ALICE, { tier: 'plus', expiresInDays: 7 });
      expect(plus.status).toBe(200);
      expect(await json(plus)).toMatchObject({ plan: { tier: 'plus', status: 'active', store: 'dev' } });
      expect(entitlement(ALICE).expiresAt!.getTime()).toBeGreaterThan(inDays(7) - 60_000);

      expect(await json(await call('POST', '/subscription/dev-grant', ALICE, { tier: 'free' }))).toMatchObject({
        plan: { tier: 'free', status: 'expired' },
      });
      expect(entitlement(BOB)).toBeUndefined();
    });

    it.each([{ tier: 'gold' }, { tier: 'plus', expiresInDays: 0 }, { tier: 'plus', userId: BOB }])('rejects %j', async (body) => {
      expect((await call('POST', '/subscription/dev-grant', ALICE, body)).status).toBe(400);
    });

    it('does not exist without the dev login (404)', async () => {
      const plain = await build(false);
      const other = plain.createNestApplication({ logger: false });
      await other.listen(0, '127.0.0.1');
      try {
        const otherTokens = await accessTokens(plain, [ALICE]);
        const response = await fetch(`${await other.getUrl()}/app/v1/subscription/dev-grant`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${otherTokens[ALICE]}` },
          body: JSON.stringify({ tier: 'plus' }),
        });
        expect(response.status).toBe(404);
      } finally {
        await other.close();
        process.env.DEV_LOGIN_ENABLED = 'true';
      }
    });
  });

  describe('/me plan, aiQuota and limits', () => {
    it('a free user: plan free, 10 messages a day, 15 places; the reset is the next local midnight', async () => {
      const response = await call('GET', '/me', ALICE, undefined, { 'x-timezone': 'Pacific/Auckland' });

      expect(response.status).toBe(200);
      const body = await json(response);
      expect(body).toMatchObject({
        id: ALICE,
        plan: { tier: 'free', status: null, expiresAt: null, willRenew: null, store: null },
        aiQuota: { limit: 10, used: 0, remaining: 10, resetsAt: localDayBounds('Pacific/Auckland').end.toISOString() },
        limits: { tripPlaces: 15 },
      });
    });

    it('a Plus user: no daily quota, 200 places', async () => {
      grantPlus(ALICE, { willRenew: false, store: 'play_store' });

      expect(await json(await call('GET', '/me', ALICE))).toMatchObject({
        plan: { tier: 'plus', status: 'active', willRenew: false, store: 'play_store' },
        aiQuota: { limit: null, used: 0, remaining: null },
        limits: { tripPlaces: 200 },
      });
    });

    it('an expired subscription: tier free, status expired', async () => {
      grantPlus(ALICE, { status: 'expired', expiresAt: new Date(Date.now() - DAY) });
      expect(await json(await call('GET', '/me', ALICE))).toMatchObject({ plan: { tier: 'free', status: 'expired' }, limits: { tripPlaces: 15 } });
    });

    it('stores a valid X-Timezone, keeps it when the header is missing or invalid', async () => {
      await call('GET', '/me', ALICE, undefined, { 'x-timezone': 'Europe/Madrid' });
      expect(db.all(User, { id: ALICE })[0].timezone).toBe('Europe/Madrid');

      const missing = await json(await call('GET', '/me', ALICE));
      await call('GET', '/me', ALICE, undefined, { 'x-timezone': 'Not/AZone' });
      expect(db.all(User, { id: ALICE })[0].timezone).toBe('Europe/Madrid');
      // Without a header, the stored zone decides the reset.
      expect((missing.aiQuota as { resetsAt: string }).resetsAt).toBe(localDayBounds('Europe/Madrid').end.toISOString());
    });
  });

  describe('AI quota', () => {
    /** A conversation of `userId` with `count` user messages (each answered) at `at`. */
    function seedMessages(userId: string, count: number, at: Date = new Date(Date.now() - 5_000)) {
      const conversation = db.seed(AiConversation, { userId, tripId: null, status: 'open', title: null, updatedAt: at });
      for (let i = 0; i < count; i += 1) {
        db.seed(AiMessage, { conversationId: conversation.id, role: 'user', text: `message ${i}`, attempts: 1, createdAt: new Date(at.getTime() + 2 * i) });
        db.seed(AiMessage, { conversationId: conversation.id, role: 'assistant', text: 'ok', createdAt: new Date(at.getTime() + 2 * i + 1) });
      }
      return conversation;
    }
    const send = (conversationId: string, message: string, user = ALICE, headers: Record<string, string> = {}) =>
      call('POST', `/ai/conversations/${conversationId}/messages`, user, { message }, headers);
    const userMessages = () => db.all(AiMessage, { role: 'user' }).length;

    it('lets the 9th and 10th messages through and refuses the 11th with 402 AI_QUOTA_EXCEEDED, storing nothing', async () => {
      const conversation = seedMessages(ALICE, 8);

      expect((await send(conversation.id, 'ninth')).status).toBe(200);
      expect((await send(conversation.id, 'tenth')).status).toBe(200);
      const refused = await send(conversation.id, 'eleventh', ALICE, { 'x-timezone': 'America/Sao_Paulo' });

      expect(refused.status).toBe(402);
      expect(await json(refused)).toEqual({
        code: 'PAYMENT_REQUIRED',
        reason: 'AI_QUOTA_EXCEEDED',
        message: expect.any(String),
        resetsAt: localDayBounds('America/Sao_Paulo').end.toISOString(),
      });
      expect(userMessages()).toBe(10);
      expect(db.all(AiMessage, { text: 'eleventh' })).toEqual([]);
    });

    it('also refuses a new conversation at the limit, creating nothing', async () => {
      seedMessages(ALICE, 10);
      const conversations = db.all(AiConversation).length;

      const refused = await call('POST', '/ai/conversations', ALICE, { message: 'A trip to Lisbon' });

      expect(refused.status).toBe(402);
      expect((await json(refused)).reason).toBe('AI_QUOTA_EXCEEDED');
      expect(db.all(AiConversation)).toHaveLength(conversations);
    });

    it('does not count retrying a failed reply (same text)', async () => {
      const conversation = seedMessages(ALICE, 9);
      // The 10th message failed: stored, no reply, no in-flight mark.
      db.seed(AiMessage, { conversationId: conversation.id, role: 'user', text: 'tenth', attempts: 1, replyingUntil: null, createdAt: new Date() });

      const retried = await send(conversation.id, 'tenth');

      expect(retried.status).toBe(200);
      expect(db.all(AiMessage, { text: 'tenth' })).toEqual([expect.objectContaining({ attempts: 2 })]);
      expect(userMessages()).toBe(10);
      expect((await send(conversation.id, 'eleventh')).status).toBe(402);
    });

    it('never blocks a Plus user (fair use only)', async () => {
      grantPlus(ALICE);
      const conversation = seedMessages(ALICE, 25);

      expect((await send(conversation.id, 'twenty-sixth')).status).toBe(200);
    });

    it('counts per user', async () => {
      seedMessages(BOB, 10);
      const conversation = seedMessages(ALICE, 0);
      expect((await send(conversation.id, 'hi')).status).toBe(200);
    });

    it.each(['America/Sao_Paulo', 'Europe/Madrid', 'Pacific/Auckland'])('resets at local midnight in %s', async (zone) => {
      const { start, end } = localDayBounds(zone);
      // Ten messages one minute before local midnight: yesterday's, so today's quota is untouched.
      const yesterday = seedMessages(ALICE, 10, new Date(start.getTime() - 60_000));
      expect((await send(yesterday.id, 'first today', ALICE, { 'x-timezone': zone })).status).toBe(200);

      // Nine more today (ten with the one above): the next one is refused until the next local midnight.
      seedMessages(ALICE, 9, new Date(Math.min(start.getTime() + 1, Date.now() - 10)));
      const refused = await send(yesterday.id, 'over', ALICE, { 'x-timezone': zone });
      expect(refused.status).toBe(402);
      expect((await json(refused)).resetsAt).toBe(end.toISOString());
    });
  });

  describe('place limit by the trip OWNER’s plan', () => {
    function seedTrip(ownerId = ALICE, members: [string, TripRole][] = [[EDITOR, 'editor']]): Trip {
      const trip = db.seed(Trip, {
        provider: null,
        chatId: null,
        ownerUserId: ownerId,
        destination: 'Lisbon',
        startDate: '2026-11-10',
        endDate: '2026-11-12',
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
      });
      db.seed(TripMember, { tripId: trip.id, userId: ownerId, role: 'owner' });
      for (const [userId, role] of members) db.seed(TripMember, { tripId: trip.id, userId, role });
      return trip;
    }
    const seedPlaces = (tripId: string, count: number) => {
      for (let i = 0; i < count; i += 1) {
        db.seed(TripPlace, {
          tripId,
          googlePlaceId: `g-${randomUUID()}`,
          name: `Place ${i}`,
          category: 'sight',
          day: null,
          position: i,
          address: 'x',
          lat: MOCK_CENTER.lat,
          lng: MOCK_CENTER.lng,
          rating: null,
          mapsUrl: null,
          types: [],
          source: 'user',
          createdBy: ALICE,
        });
      }
    };
    const add = (tripId: string, user: string) => call('POST', `/trips/${tripId}/places`, user, { googlePlaceId: `mock-${randomUUID().slice(0, 8)}` });

    it('refuses the 16th place for a free owner, and for their editor, with 402 and the limit', async () => {
      const trip = seedTrip();
      seedPlaces(trip.id, 14);
      expect((await add(trip.id, ALICE)).status).toBe(201);

      for (const user of [ALICE, EDITOR]) {
        const refused = await add(trip.id, user);
        expect(refused.status).toBe(402);
        expect(await json(refused)).toEqual({
          code: 'PAYMENT_REQUIRED',
          reason: 'TRIP_PLACES_PLUS_REQUIRED',
          message: expect.any(String),
          limit: 15,
        });
      }
      expect(db.all(TripPlace, { tripId: trip.id })).toHaveLength(15);
    });

    it('follows the owner, not the editor: a Plus owner allows 200, a Plus editor on a free owner’s trip still 15', async () => {
      const ownedByPlus = seedTrip(BOB, [[EDITOR, 'editor']]);
      grantPlus(BOB);
      seedPlaces(ownedByPlus.id, 15);
      expect((await add(ownedByPlus.id, EDITOR)).status).toBe(201);

      const ownedByFree = seedTrip(ALICE, [[EDITOR, 'editor']]);
      grantPlus(EDITOR);
      seedPlaces(ownedByFree.id, 15);
      expect((await add(ownedByFree.id, EDITOR)).status).toBe(402);
    });

    it('keeps every place after a downgrade, and only blocks adding', async () => {
      const trip = seedTrip();
      grantPlus(ALICE, { status: 'expired', expiresAt: new Date(Date.now() - DAY) });
      seedPlaces(trip.id, 20);

      const listed = await json<{ places: { id: string }[]; itineraryVersion: number }>(await call('GET', `/trips/${trip.id}/places`, ALICE));
      expect(listed.places).toHaveLength(20);
      expect((await add(trip.id, ALICE)).status).toBe(402);
      expect((await call('DELETE', `/trips/${trip.id}/places/${listed.places[0].id}`, ALICE)).status).toBe(204);
      const reordered = await call('PUT', `/trips/${trip.id}/itinerary`, ALICE, {
        itineraryVersion: 1,
        days: [{ day: null, placeIds: listed.places.slice(1).reverse().map((p) => p.id) }],
      });
      expect(reordered.status).toBe(200);
      expect(db.all(TripPlace, { tripId: trip.id })).toHaveLength(19);
    });

    it('AI confirm adds up to the limit and counts the rest in skippedForPlan', async () => {
      const trip = seedTrip();
      seedPlaces(trip.id, 14);
      const started = await json<{ conversation: { id: string } }>(
        await call('POST', '/ai/conversations', ALICE, { message: 'Places to visit in Lisbon', tripId: trip.id }),
      );

      const confirmed = await call('POST', `/ai/conversations/${started.conversation.id}/confirm`, ALICE, {});

      expect(confirmed.status).toBe(200);
      expect(await json(confirmed)).toMatchObject({ added: 1, skipped: 0, skippedForPlan: 2 });
      expect(db.all(TripPlace, { tripId: trip.id })).toHaveLength(15);
    });
  });

  it('never logs secrets or emails', async () => {
    rest.getSubscriber.mockResolvedValue({ entitlements: {}, subscriptions: {} });
    await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE, expiration_at_ms: inDays(30) });
    await webhook({ type: 'INITIAL_PURCHASE', app_user_id: ALICE }, 'Bearer nope');
    rest.getSubscriber.mockRejectedValue(new Error('RevenueCat subscriber lookup failed: HTTP 500'));
    await call('POST', '/subscription/sync', ALICE);
    await call('GET', '/me', ALICE);

    const all = logs.join('\n');
    expect(all).not.toContain('whsec');
    expect(all).not.toContain('@private.example');
  });
});
