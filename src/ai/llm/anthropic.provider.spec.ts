import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { AnthropicProvider, ANTHROPIC_MESSAGES_URL } from './anthropic.provider.js';
import { AiUnavailableError } from './llm-provider.js';
import type { DraftTurnInput } from './llm-provider.js';
import type { FetchFn } from './http-json.js';

const SCHEMA = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const INPUT: DraftTurnInput = {
  system: 'You are the trip planner.',
  history: [
    { role: 'user', text: 'Lisbon in May' },
    { role: 'assistant', text: '{"reply":"Nice"}' },
    { role: 'user', text: '3 people' },
  ],
  schema: SCHEMA,
  signal: new AbortController().signal,
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const message = (overrides: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: '{"reply":"Hi"}' },
  ],
  stop_reason: 'end_turn',
  stop_details: null,
  usage: { input_tokens: 120, output_tokens: 30 },
  ...overrides,
});

function provider(responses: (Response | Error)[], options: Partial<ConstructorParameters<typeof AnthropicProvider>[0]> = {}) {
  const queue = [...responses];
  const fetch = jest.fn<FetchFn>(async () => {
    const next = queue.shift();
    if (!next) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = jest.fn(async (_ms: number) => undefined);
  const instance = new AnthropicProvider({
    apiKey: 'sk-ant-test',
    model: 'claude-sonnet-5-5',
    maxTokens: 4096,
    effort: 'low',
    timeoutMs: 1000,
    fetch,
    sleep,
    ...options,
  });
  return { instance, fetch, sleep };
}

const sentBody = (fetch: jest.Mock<FetchFn>, call = 0) => JSON.parse(String(fetch.mock.calls[call][1]!.body)) as Record<string, unknown>;
const sentHeaders = (fetch: jest.Mock<FetchFn>, call = 0) => fetch.mock.calls[call][1]!.headers as Record<string, string>;

describe('AnthropicProvider', () => {
  let errorLog: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the Messages API request the spec describes', async () => {
    const { instance, fetch } = provider([json(200, message())]);

    await instance.draftTurn(INPUT);

    expect(fetch.mock.calls[0][0]).toBe(ANTHROPIC_MESSAGES_URL);
    expect(fetch.mock.calls[0][1]!.method).toBe('POST');
    expect(sentHeaders(fetch)).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    });
    expect(sentBody(fetch)).toEqual({
      model: 'claude-sonnet-5-5',
      max_tokens: 4096,
      system: 'You are the trip planner.',
      messages: [
        { role: 'user', content: 'Lisbon in May' },
        { role: 'assistant', content: '{"reply":"Nice"}' },
        { role: 'user', content: '3 people' },
      ],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('sends anthropic-workspace-id when a workspace id is set, and never logs it', async () => {
    const logs = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
    const { instance, fetch } = provider([json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'x' } })], {
      workspaceId: 'wrkspc_01SECRETID',
    });

    await expect(instance.draftTurn(INPUT)).rejects.toBeInstanceOf(AiUnavailableError);

    expect(sentHeaders(fetch)['anthropic-workspace-id']).toBe('wrkspc_01SECRETID');
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain('wrkspc_01SECRETID');
  });

  it.each([undefined, null, ''])('sends no anthropic-workspace-id when it is %p', async (workspaceId) => {
    const { instance, fetch } = provider([json(200, message())], { workspaceId });

    await instance.draftTurn(INPUT);

    expect(sentHeaders(fetch)).not.toHaveProperty('anthropic-workspace-id');
  });

  it('can leave out effort (models without it) and switch fallbacks off, header included', async () => {
    const { instance, fetch } = provider([json(200, message())], { effort: null, fallbacks: 'off', model: 'claude-haiku-4-5' });

    await instance.draftTurn(INPUT);

    const body = sentBody(fetch);
    expect(body.output_config).toEqual({ format: { type: 'json_schema', schema: SCHEMA } });
    expect(body).not.toHaveProperty('fallbacks');
    expect(body.model).toBe('claude-haiku-4-5');
    expect(sentHeaders(fetch)).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
    });
  });

  it('never disables thinking and never prefills (the last message is the user turn)', async () => {
    const { instance, fetch } = provider([json(200, message())]);
    await instance.draftTurn(INPUT);
    const body = sentBody(fetch);

    expect(body).not.toHaveProperty('thinking');
    expect((body.messages as { role: string }[]).at(-1)!.role).toBe('user');
  });

  it('parses the text blocks as JSON and reports the serving model and usage', async () => {
    const { instance } = provider([
      json(
        200,
        message({
          model: 'claude-opus-4-8',
          content: [
            { type: 'fallback', from: { model: 'claude-sonnet-5-5' }, to: { model: 'claude-opus-4-8' } },
            { type: 'text', text: '{"reply":' },
            { type: 'text', text: '"Olá"}' },
          ],
        }),
      ),
    ]);

    await expect(instance.draftTurn(INPUT)).resolves.toEqual({
      json: { reply: 'Olá' },
      model: 'claude-opus-4-8',
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it('treats a refusal (after fallbacks) as unavailable', async () => {
    const { instance } = provider([json(200, message({ content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }))]);
    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('anthropic: refusal'));
  });

  it('retries max_tokens once with double the room, adding up usage', async () => {
    const { instance, fetch } = provider([
      json(200, message({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"rep' }] })),
      json(200, message()),
    ]);

    await expect(instance.draftTurn(INPUT)).resolves.toMatchObject({ inputTokens: 240, outputTokens: 60 });
    expect(sentBody(fetch, 1).max_tokens).toBe(8192);
  });

  it('gives up after a second max_tokens', async () => {
    const { instance } = provider([json(200, message({ stop_reason: 'max_tokens' })), json(200, message({ stop_reason: 'max_tokens' }))]);
    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('anthropic: max_tokens'));
  });

  it('rejects output that is not JSON', async () => {
    const { instance } = provider([json(200, message({ content: [{ type: 'text', text: 'Sure! Here you go' }] }))]);
    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('anthropic: output is not JSON'));
  });

  it.each([408, 429, 500, 502, 503, 504, 529])('retries HTTP %i, then succeeds', async (status) => {
    const { instance, fetch, sleep } = provider([json(status, { type: 'error', error: { type: 'overloaded_error', message: 'x' } }), json(200, message())]);

    await expect(instance.draftTurn(INPUT)).resolves.toMatchObject({ json: { reply: 'Hi' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries at most twice, then is unavailable', async () => {
    const overloaded = () => json(529, { type: 'error', error: { type: 'overloaded_error', message: 'x' } });
    const { instance, fetch } = provider([overloaded(), overloaded(), overloaded()]);

    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('anthropic: HTTP 529 overloaded_error'));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('waits for retry-after when the API sends one', async () => {
    const { instance, sleep } = provider([
      json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, { 'retry-after': '3' }),
      json(200, message()),
    ]);
    await instance.draftTurn(INPUT);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('does not wait out a long retry-after', async () => {
    const { instance, fetch } = provider([json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'x' } }, { 'retry-after': '120' })]);
    await expect(instance.draftTurn(INPUT)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
  ])('never retries HTTP %i and logs only its error type', async (status, type) => {
    const { instance, fetch } = provider([json(status, { type: 'error', error: { type, message: 'secret details: sk-ant-test' } })]);

    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError(`anthropic: HTTP ${status} ${type}`));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(`anthropic: HTTP ${status} ${type}`);
  });

  it('retries network failures', async () => {
    const { instance, fetch } = provider([new TypeError('fetch failed'), json(200, message())]);
    await expect(instance.draftTurn(INPUT)).resolves.toMatchObject({ json: { reply: 'Hi' } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('times out each attempt with AI_TIMEOUT_MS', async () => {
    const hang: FetchFn = (_url, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const instance = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-sonnet-5-5',
      maxTokens: 10,
      effort: 'low',
      timeoutMs: 20,
      maxRetries: 0,
      fetch: hang,
      sleep: async () => undefined,
    });
    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('anthropic: timeout'));
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { instance, fetch } = provider([json(200, message())]);
    await expect(instance.draftTurn({ ...INPUT, signal: controller.signal })).rejects.toEqual(new AiUnavailableError('anthropic: aborted'));
    expect(fetch).not.toHaveBeenCalled();
  });
});
