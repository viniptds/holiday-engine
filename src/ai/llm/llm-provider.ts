/** A JSON Schema object, as sent to the providers' structured-output options. */
export type JsonSchema = Record<string, unknown>;

export type LlmHistoryEntry = { role: 'user' | 'assistant'; text: string };

export type DraftTurnInput = {
  system: string;
  /** Oldest first; ends with a user message. */
  history: LlmHistoryEntry[];
  schema: JsonSchema;
  signal: AbortSignal;
};

export type DraftTurnResult = { json: unknown; model: string; inputTokens: number; outputTokens: number };

/** One structured-output call to a chat model. Throws `AiUnavailableError` on any provider failure. */
export interface LlmProvider {
  readonly name: 'anthropic' | 'openai' | 'mock';
  draftTurn(input: DraftTurnInput): Promise<DraftTurnResult>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

/**
 * The provider can't produce a turn right now (down, timed out, rate-limited, refused, bad key...).
 * `reason` is for logs only: it never holds message text or secrets.
 */
export class AiUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`AI provider unavailable: ${reason}`);
    this.name = 'AiUnavailableError';
  }
}
