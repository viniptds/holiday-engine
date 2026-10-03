import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { OpenAiProvider, OPENAI_CHAT_COMPLETIONS_URL } from './openai.provider.js';
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

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const completion = (choice: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion',
  model: 'gpt-x-2026',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"Hi"}', refusal: null }, ...choice }],
  usage: { prompt_tokens: 90, completion_tokens: 20, total_tokens: 110 },
  ...overrides,
});

function provider(responses: Response[]) {
  const queue = [...responses];
  const fetch = jest.fn<FetchFn>(async () => queue.shift() ?? Promise.reject(new Error('unexpected fetch')));
  const instance = new OpenAiProvider({ apiKey: 'sk-openai-test', model: 'gpt-x', maxTokens: 4096, timeoutMs: 1000, fetch, sleep: async () => undefined });
  return { instance, fetch };
}

const sentBody = (fetch: jest.Mock<FetchFn>, call = 0) => JSON.parse(String(fetch.mock.calls[call][1]!.body)) as Record<string, unknown>;

describe('OpenAiProvider', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends a Chat Completions request with a strict json_schema response format', async () => {
    const { instance, fetch } = provider([json(200, completion())]);

    await instance.draftTurn(INPUT);

    expect(fetch.mock.calls[0][0]).toBe(OPENAI_CHAT_COMPLETIONS_URL);
    expect(fetch.mock.calls[0][1]!.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk-openai-test' });
    expect(sentBody(fetch)).toEqual({
      model: 'gpt-x',
      max_completion_tokens: 4096,
      messages: [
        { role: 'developer', content: 'You are the trip planner.' },
        { role: 'user', content: 'Lisbon in May' },
        { role: 'assistant', content: '{"reply":"Nice"}' },
        { role: 'user', content: '3 people' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'trip_draft', strict: true, schema: SCHEMA } },
    });
  });

  it('parses the message content and reports model and usage', async () => {
    const { instance } = provider([json(200, completion())]);
    await expect(instance.draftTurn(INPUT)).resolves.toEqual({ json: { reply: 'Hi' }, model: 'gpt-x-2026', inputTokens: 90, outputTokens: 20 });
  });

  it('treats a refusal or a content filter stop as unavailable', async () => {
    const refused = provider([json(200, completion({ message: { role: 'assistant', content: null, refusal: 'I cannot help.' } }))]);
    await expect(refused.instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('openai: refusal'));

    const filtered = provider([json(200, completion({ finish_reason: 'content_filter' }))]);
    await expect(filtered.instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('openai: content_filter'));
  });

  it('retries a length stop once with double max_completion_tokens', async () => {
    const { instance, fetch } = provider([json(200, completion({ finish_reason: 'length' })), json(200, completion())]);
    await expect(instance.draftTurn(INPUT)).resolves.toMatchObject({ inputTokens: 180, outputTokens: 40 });
    expect(sentBody(fetch, 1).max_completion_tokens).toBe(8192);
  });

  it('retries 429 and 5xx, but not 4xx', async () => {
    const limited = provider([json(429, { error: { type: 'rate_limit_exceeded', message: 'x' } }), json(200, completion())]);
    await expect(limited.instance.draftTurn(INPUT)).resolves.toMatchObject({ json: { reply: 'Hi' } });

    const unauthorized = provider([json(401, { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'x' } })]);
    await expect(unauthorized.instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('openai: HTTP 401 invalid_request_error'));
    expect(unauthorized.fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects content that is not JSON', async () => {
    const { instance } = provider([json(200, completion({ message: { role: 'assistant', content: 'hello', refusal: null } }))]);
    await expect(instance.draftTurn(INPUT)).rejects.toEqual(new AiUnavailableError('openai: output is not JSON'));
  });
});
