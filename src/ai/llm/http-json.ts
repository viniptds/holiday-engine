import { Logger } from '@nestjs/common';
import { AiUnavailableError } from './llm-provider.js';

export type FetchFn = typeof fetch;
export type SleepFn = (ms: number) => Promise<void>;

export const realSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth retrying: timeouts, rate limits, server errors and Anthropic's 529 overloaded. */
export const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

const MAX_RETRY_AFTER_MS = 10_000;

export type PostJsonOptions = {
  /** For logs: `anthropic`, `openai`. */
  provider: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  maxRetries: number;
  signal?: AbortSignal;
  fetch: FetchFn;
  sleep: SleepFn;
  logger: Logger;
};

/** `retry-after` in ms (seconds or an HTTP date), or null. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Exponential backoff with full jitter: 0..(500 ms × 2^attempt), at most 8 s. */
export function backoffMs(attempt: number, random = Math.random): number {
  return Math.floor(random() * Math.min(8000, 500 * 2 ** attempt));
}

/** The provider error `type` from an error body (`{ error: { type } }`), for logs. Never the message. */
function errorType(body: unknown): string {
  const error = (body as { error?: { type?: unknown; code?: unknown } } | null)?.error;
  const type = typeof error?.type === 'string' ? error.type : typeof error?.code === 'string' ? error.code : null;
  return type ?? 'unknown';
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * POSTs JSON and returns the parsed 2xx body. Each attempt has its own timeout. Retries network
 * failures, timeouts and RETRYABLE_STATUSES up to `maxRetries` times (backoff with jitter, honouring
 * `retry-after` up to 10 s). Anything else, or running out of retries, throws `AiUnavailableError`.
 */
export async function postJson(options: PostJsonOptions): Promise<unknown> {
  const { provider, logger } = options;
  let lastReason = 'unknown';
  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    if (options.signal?.aborted) throw new AiUnavailableError(`${provider}: aborted`);
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await options.fetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw new AiUnavailableError(`${provider}: aborted`);
      lastReason = timeout.aborted ? 'timeout' : `network error (${(error as Error)?.name ?? 'Error'})`;
      if (attempt < options.maxRetries) {
        logger.warn(`${provider}: ${lastReason}, retrying (attempt ${attempt + 1})`);
        await options.sleep(backoffMs(attempt));
        continue;
      }
      throw new AiUnavailableError(`${provider}: ${lastReason}`);
    }

    if (response.ok) {
      const body = await readJson(response);
      if (body === null) throw new AiUnavailableError(`${provider}: response is not JSON`);
      return body;
    }

    const type = errorType(await readJson(response));
    lastReason = `HTTP ${response.status} ${type}`;
    if (!RETRYABLE_STATUSES.has(response.status)) {
      // Bad key, bad request, no credit...: retrying won't help, and someone needs to look.
      logger.error(`${provider}: ${lastReason}`);
      throw new AiUnavailableError(`${provider}: ${lastReason}`);
    }
    if (attempt < options.maxRetries) {
      const hinted = retryAfterMs(response.headers.get('retry-after'));
      if (hinted !== null && hinted > MAX_RETRY_AFTER_MS) break;
      logger.warn(`${provider}: ${lastReason}, retrying (attempt ${attempt + 1})`);
      await options.sleep(hinted ?? backoffMs(attempt));
    }
  }
  throw new AiUnavailableError(`${provider}: ${lastReason}`);
}
