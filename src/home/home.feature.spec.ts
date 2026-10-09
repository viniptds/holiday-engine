import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import type { AiConversationSummary } from '../ai/ai.types.js';
import { BannersService } from './banners.service.js';
import { CopyRefreshService } from './copy-refresh.service.js';
import { HomeCopy } from './home-copy.entity.js';
import { HOME_COPY_TTL_MS } from './home.types.js';
import type { BannersDto, HomeDto } from './home.types.js';
import { ANA, BEN, bootHome, LISBON, NOW } from './testing/harness.js';
import type { HomeHarness } from './testing/harness.js';
import { readHomeConfig } from './home.config.js';

describe('Home: drafts and the nightly copy refresh (feature)', () => {
  let h: HomeHarness;

  beforeAll(async () => {
    h = await bootHome({ HOME_COPY_AI_REFRESH: 'true', HOME_COPY_AI_MAX_PER_NIGHT: '2' });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(() => {
    h.reset();
  });

  const conversation = (user: string, i: number, status: 'open' | 'confirmed' | 'abandoned' = 'open', withDraft = true) => {
    const at = new Date(NOW.getTime() - i * 60_000);
    const c = h.db.seed(AiConversation, { userId: user, status, title: withDraft ? `Porto ${i}` : null, createdAt: at, updatedAt: at });
    h.db.seed(AiMessage, { conversationId: c.id, role: 'user', text: `  Take me to   Porto ${i} ${'x'.repeat(100)}`, createdAt: new Date(at.getTime() - 2000) });
    if (withDraft) {
      h.db.seed(AiMessage, {
        conversationId: c.id,
        role: 'assistant',
        text: 'Here is a plan',
        draft: { ready: i % 2 === 0, destination: `Porto ${i}`, startDate: '2026-11-01', endDate: i % 2 === 0 ? '2026-11-03' : null, partyType: null, partySize: null, story: null, places: [], questions: [] },
        createdAt: new Date(at.getTime() - 1000),
      });
    }
    return c;
  };

  it('lists open drafts newest first with a summary, at most 5, and says when there are more', async () => {
    for (let i = 0; i < 7; i += 1) conversation(ANA, i);
    conversation(ANA, 10, 'confirmed');
    conversation(ANA, 11, 'abandoned');
    conversation(BEN, 0);
    const { status, body } = await h.json<HomeDto>('GET', '/home', ANA);
    expect(status).toBe(200);
    expect(body.hasMoreDrafts).toBe(true);
    expect(body.drafts).toHaveLength(5);
    expect(body.drafts.map((d) => d.title)).toEqual(['Porto 0', 'Porto 1', 'Porto 2', 'Porto 3', 'Porto 4']);
    const first = body.drafts[0];
    expect(first.status).toBe('open');
    expect(first.draftSummary).toEqual({ destination: 'Porto 0', startDate: '2026-11-01', endDate: '2026-11-03', ready: true });
    expect(body.drafts[1].draftSummary).toEqual({ destination: 'Porto 1', startDate: '2026-11-01', endDate: null, ready: false });
    expect(first.lastMessagePreview).toHaveLength(80);
    expect(first.lastMessagePreview!.startsWith('Take me to Porto 0 xxx')).toBe(true);
    expect(first.lastMessageAt).toBe(new Date(NOW.getTime() - 1000).toISOString());
    expect(first.messageCount).toBe(2);
    expect(body.drafts.every((d) => d.id !== undefined)).toBe(true);
  });

  it('adds the summary fields to the conversation list, filtered by status', async () => {
    conversation(ANA, 0);
    conversation(ANA, 1, 'open', false);
    conversation(ANA, 2, 'confirmed');
    const open = await h.json<{ conversations: AiConversationSummary[] }>('GET', '/ai/conversations?status=open', ANA);
    expect(open.status).toBe(200);
    expect(open.body.conversations.map((c) => c.title)).toEqual(['Porto 0', null]);
    expect(open.body.conversations[1]).toMatchObject({ draftSummary: null, messageCount: 1, lastMessagePreview: expect.stringContaining('Take me to Porto 1') });
    const all = await h.json<{ conversations: AiConversationSummary[] }>('GET', '/ai/conversations', ANA);
    expect(all.body.conversations).toHaveLength(3);
    expect((await h.json('GET', '/ai/conversations?status=lost', ANA)).status).toBe(400);
    const empty = await h.json<HomeDto>('GET', '/home', BEN);
    expect(empty.body).toEqual({ drafts: [], hasMoreDrafts: false });
  });

  it('refreshes copy for the served banners through the mock LLM, bounded per night, and serves it ahead of the curated set', async () => {
    const refresh = h.moduleRef.get(CopyRefreshService);
    const banners = h.moduleRef.get(BannersService);
    expect(await refresh.run()).toEqual({ calls: 0, stored: 0, skipped: 0 }); // nothing served yet
    const before = await h.json<BannersDto>('GET', `/home/banners?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA);
    expect(before.body.banners.length).toBeGreaterThanOrEqual(3);
    const servedCombos = banners.recentlyServed().length; // nearby, longWeekend, 3 bigTrip angles
    expect(servedCombos).toBe(5);

    expect(await refresh.run()).toEqual({ calls: 2, stored: 2, skipped: 0 }); // HOME_COPY_AI_MAX_PER_NIGHT=2
    const rows = h.db.all(HomeCopy);
    expect(rows).toHaveLength(2);
    expect(rows[0].expiresAt.toISOString()).toBe(new Date(NOW.getTime() + HOME_COPY_TTL_MS).toISOString());
    expect(rows[0].variants).toHaveLength(3);
    expect(rows[0].model).toBe('mock');
    expect(rows[0].variants[0].headline).toMatch(/, a fresh idea$/);

    // The next night skips the fresh rows and continues with the others.
    expect(await refresh.run()).toEqual({ calls: 2, stored: 2, skipped: 2 });
    expect(await refresh.run()).toEqual({ calls: 1, stored: 1, skipped: 4 });
    expect(await refresh.run()).toEqual({ calls: 0, stored: 0, skipped: 5 });

    banners.resetCache();
    const after = await h.json<BannersDto>('GET', `/home/banners?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA);
    const stored = new Set(h.db.all(HomeCopy).map((r) => `${r.destinationId}|${r.tier}`));
    for (const banner of after.body.banners) {
      if (!stored.has(`${banner.destinationId}|${banner.tier}`)) continue;
      expect(banner.headline).toMatch(/, (a fresh idea|worth a look|on your list)$/);
      expect(banner.plannerPrompt).not.toMatch(/fresh idea/); // the prompt stays curated
    }

    // After the 7-day TTL the rows are regenerated.
    const later = new Date(NOW.getTime() + HOME_COPY_TTL_MS + 60_000);
    refresh.now = () => later;
    expect(await refresh.run()).toEqual({ calls: 2, stored: 2, skipped: 0 });
    expect(h.db.all(HomeCopy)).toHaveLength(5);
    expect(h.db.all(HomeCopy).filter((r) => r.expiresAt.getTime() > later.getTime())).toHaveLength(2);
  });

  it('is off by default and validates its settings', async () => {
    const off = await bootHome();
    try {
      await off.json('GET', `/home/banners?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA);
      expect(await off.moduleRef.get(CopyRefreshService).run()).toEqual({ calls: 0, stored: 0, skipped: 0 });
      expect(off.db.all(HomeCopy)).toHaveLength(0);
    } finally {
      await off.close();
    }
    const get = (values: Record<string, string>) => (key: string) => values[key];
    expect(readHomeConfig(get({}))).toEqual({ weatherCacheMs: 30 * 60_000, copyAiRefresh: false, copyAiMaxPerNight: 300 });
    expect(readHomeConfig(get({ HOME_WEATHER_CACHE_MINUTES: '5', HOME_COPY_AI_REFRESH: 'true', HOME_COPY_AI_MAX_PER_NIGHT: '10' }))).toEqual({ weatherCacheMs: 5 * 60_000, copyAiRefresh: true, copyAiMaxPerNight: 10 });
    expect(() => readHomeConfig(get({ HOME_WEATHER_CACHE_MINUTES: '0' }))).toThrow(/HOME_WEATHER_CACHE_MINUTES/);
    expect(() => readHomeConfig(get({ HOME_COPY_AI_REFRESH: 'yes' }))).toThrow(/HOME_COPY_AI_REFRESH/);
    expect(() => readHomeConfig(get({ HOME_COPY_AI_MAX_PER_NIGHT: '-1' }))).toThrow(/HOME_COPY_AI_MAX_PER_NIGHT/);
  });
});
