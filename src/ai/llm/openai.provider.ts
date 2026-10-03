import { Logger } from '@nestjs/common';
import { AiUnavailableError } from './llm-provider.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from './llm-provider.js';
import { postJson, realSleep } from './http-json.js';
import type { FetchFn, SleepFn } from './http-json.js';

export const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

export type OpenAiOptions = {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  maxRetries?: number;
  fetch?: FetchFn;
  sleep?: SleepFn;
};

type ChatCompletion = {
  model?: string;
  choices?: { finish_reason?: string | null; message?: { content?: string | null; refusal?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * OpenAI Chat Completions over plain `fetch` (shape per the official API reference and `openai`
 * SDK types): instructions as a `developer` message, `max_completion_tokens`, and a strict
 * `json_schema` response format.
 */
export class OpenAiProvider implements LlmProvider {
  readonly name = 'openai' as const;
  private readonly logger = new Logger(OpenAiProvider.name);
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;

  constructor(private readonly options: OpenAiOptions) {
    this.fetch = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? realSleep;
  }

  buildBody(input: Omit<DraftTurnInput, 'signal'>, maxTokens = this.options.maxTokens) {
    return {
      model: this.options.model,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'developer', content: input.system },
        ...input.history.map((entry) => ({ role: entry.role, content: entry.text })),
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'trip_draft', strict: true, schema: input.schema } },
    };
  }

  async draftTurn(input: DraftTurnInput): Promise<DraftTurnResult> {
    let maxTokens = this.options.maxTokens;
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = (await postJson({
        provider: this.name,
        url: OPENAI_CHAT_COMPLETIONS_URL,
        headers: { authorization: `Bearer ${this.options.apiKey}` },
        body: this.buildBody(input, maxTokens),
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries ?? 2,
        signal: input.signal,
        fetch: this.fetch,
        sleep: this.sleep,
        logger: this.logger,
      })) as ChatCompletion;

      inputTokens += response.usage?.prompt_tokens ?? 0;
      outputTokens += response.usage?.completion_tokens ?? 0;

      const choice = response.choices?.[0];
      if (choice?.message?.refusal) throw new AiUnavailableError('openai: refusal');
      if (choice?.finish_reason === 'content_filter') throw new AiUnavailableError('openai: content_filter');
      if (choice?.finish_reason === 'length') {
        maxTokens *= 2;
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(choice?.message?.content ?? '');
      } catch {
        throw new AiUnavailableError('openai: output is not JSON');
      }
      return { json, model: response.model ?? this.options.model, inputTokens, outputTokens };
    }
    throw new AiUnavailableError('openai: length');
  }
}
