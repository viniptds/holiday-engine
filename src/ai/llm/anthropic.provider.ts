import { Logger } from '@nestjs/common';
import type { AiEffort, AiFallbacks } from '../ai.config.js';
import { AiUnavailableError } from './llm-provider.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from './llm-provider.js';
import { postJson, realSleep } from './http-json.js';
import type { FetchFn, SleepFn } from './http-json.js';

export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** Server-side fallback with `fallbacks: "default"`: a safety refusal is rerouted to another model. */
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type AnthropicOptions = {
  apiKey: string;
  model: string;
  maxTokens: number;
  /** null → `output_config.effort` isn't sent. */
  effort: AiEffort | null;
  /** `off` → neither the `fallbacks` field nor its beta header. Default `default`. */
  fallbacks?: AiFallbacks;
  timeoutMs: number;
  /** Sent as `anthropic-workspace-id` when set: required for API keys not scoped to a workspace. Never logged. */
  workspaceId?: string | null;
  maxRetries?: number;
  fetch?: FetchFn;
  sleep?: SleepFn;
};

type ContentBlock = { type: string; text?: string };
type MessagesResponse = {
  model?: string;
  content?: ContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Claude through the Messages API over plain `fetch` (no SDK, by decision). Structured output via
 * `output_config.format`; thinking is left at the model default (`disabled` is a 400 on Sonnet 5.5)
 * and there is no assistant prefill. Top-level `cache_control` caches the system prompt and history.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly logger = new Logger(AnthropicProvider.name);
  private readonly fetch: FetchFn;
  private readonly sleep: SleepFn;

  constructor(private readonly options: AnthropicOptions) {
    this.fetch = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? realSleep;
  }

  /** The request body. Exported shape is pinned by tests. */
  private get fallbacksOn(): boolean {
    return (this.options.fallbacks ?? 'default') === 'default';
  }

  buildBody(input: Omit<DraftTurnInput, 'signal'>, maxTokens = this.options.maxTokens) {
    const format = { type: 'json_schema', schema: input.schema };
    return {
      model: this.options.model,
      max_tokens: maxTokens,
      system: input.system,
      messages: input.history.map((entry) => ({ role: entry.role, content: entry.text })),
      output_config: this.options.effort ? { effort: this.options.effort, format } : { format },
      ...(this.fallbacksOn ? { fallbacks: 'default' } : {}),
      cache_control: { type: 'ephemeral' },
    };
  }

  buildHeaders(): Record<string, string> {
    return {
      'x-api-key': this.options.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      ...(this.options.workspaceId ? { 'anthropic-workspace-id': this.options.workspaceId } : {}),
      ...(this.fallbacksOn ? { 'anthropic-beta': ANTHROPIC_FALLBACK_BETA } : {}),
    };
  }

  async draftTurn(input: DraftTurnInput): Promise<DraftTurnResult> {
    let maxTokens = this.options.maxTokens;
    let inputTokens = 0;
    let outputTokens = 0;
    // A reply cut off by max_tokens is retried once with twice the room.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = (await postJson({
        provider: this.name,
        url: ANTHROPIC_MESSAGES_URL,
        headers: this.buildHeaders(),
        body: this.buildBody(input, maxTokens),
        timeoutMs: this.options.timeoutMs,
        maxRetries: this.options.maxRetries ?? 2,
        signal: input.signal,
        fetch: this.fetch,
        sleep: this.sleep,
        logger: this.logger,
      })) as MessagesResponse;

      inputTokens += response.usage?.input_tokens ?? 0;
      outputTokens += response.usage?.output_tokens ?? 0;

      // Check stop_reason before reading content. With fallbacks on, a refusal here is final: they already ran.
      if (response.stop_reason === 'refusal') throw new AiUnavailableError('anthropic: refusal');
      if (response.stop_reason === 'max_tokens') {
        maxTokens *= 2;
        continue;
      }

      const text = (response.content ?? [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiUnavailableError('anthropic: output is not JSON');
      }
      return { json, model: response.model ?? this.options.model, inputTokens, outputTokens };
    }
    throw new AiUnavailableError('anthropic: max_tokens');
  }
}
