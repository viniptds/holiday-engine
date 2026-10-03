import type { ConfigService } from '@nestjs/config';

export const LLM_PROVIDERS = ['anthropic', 'openai', 'mock'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const PLACES_PROVIDERS = ['google', 'mock'] as const;
export type PlacesProviderName = (typeof PLACES_PROVIDERS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

export const AI_FALLBACK_MODES = ['default', 'off'] as const;
export type AiFallbacks = (typeof AI_FALLBACK_MODES)[number];

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

export type AiConfig = {
  provider: LlmProviderName;
  model: string;
  /** Key of the selected provider (empty for mock). */
  apiKey: string;
  timeoutMs: number;
  maxTokens: number;
  /** Anthropic `output_config.effort`; null → not sent (models without effort, e.g. Haiku 4.5). */
  effort: AiEffort | null;
  /** Anthropic server-side fallbacks: `default` sends `fallbacks: "default"` and its beta header. */
  fallbacks: AiFallbacks;
  placesProvider: PlacesProviderName;
  placesApiKey: string;
};

type Env = Record<string, string | undefined>;

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function oneOf<T extends string>(env: Env, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new Error(`${name} must be one of ${allowed.join(', ')}`);
  return raw as T;
}

/**
 * Reads and checks the AI settings. Throws (failing startup) on a missing key for the selected
 * provider, on bad values, and on mock providers in production. Error messages name settings only,
 * never their values.
 */
export function readAiConfig(env: Env): AiConfig {
  const production = env.NODE_ENV === 'production';
  const provider = oneOf(env, 'AI_PROVIDER', LLM_PROVIDERS, 'mock');
  const placesProvider = oneOf(env, 'PLACES_PROVIDER', PLACES_PROVIDERS, 'mock');
  if (production && provider === 'mock') throw new Error('AI_PROVIDER=mock is not allowed in production');
  if (production && placesProvider === 'mock') throw new Error('PLACES_PROVIDER=mock is not allowed in production');

  let apiKey = '';
  let model = env.AI_MODEL?.trim() ?? '';
  if (provider === 'anthropic') {
    apiKey = env.ANTHROPIC_API_KEY?.trim() ?? '';
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic');
    model ||= DEFAULT_ANTHROPIC_MODEL;
  } else if (provider === 'openai') {
    apiKey = env.OPENAI_API_KEY?.trim() ?? '';
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when AI_PROVIDER=openai');
    if (!model) throw new Error('AI_MODEL is required when AI_PROVIDER=openai');
  } else {
    model ||= 'mock';
  }

  const placesApiKey = placesProvider === 'google' ? (env.GOOGLE_PLACES_API_KEY?.trim() ?? '') : '';
  if (placesProvider === 'google' && !placesApiKey) {
    throw new Error('GOOGLE_PLACES_API_KEY is required when PLACES_PROVIDER=google');
  }

  return {
    provider,
    model,
    apiKey,
    timeoutMs: positiveInt(env, 'AI_TIMEOUT_MS', 30_000),
    maxTokens: positiveInt(env, 'AI_MAX_TOKENS', 4096),
    // Unset → low; set but empty → not sent.
    effort: env.AI_EFFORT !== undefined && env.AI_EFFORT.trim() === '' ? null : oneOf(env, 'AI_EFFORT', AI_EFFORTS, 'low'),
    fallbacks: oneOf(env, 'AI_FALLBACKS', AI_FALLBACK_MODES, 'default'),
    placesProvider,
    placesApiKey,
  };
}

const AI_ENV_KEYS = [
  'NODE_ENV',
  'AI_PROVIDER',
  'AI_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'AI_TIMEOUT_MS',
  'AI_MAX_TOKENS',
  'AI_EFFORT',
  'AI_FALLBACKS',
  'PLACES_PROVIDER',
  'GOOGLE_PLACES_API_KEY',
];

export function aiConfigFrom(config: ConfigService): AiConfig {
  return readAiConfig(Object.fromEntries(AI_ENV_KEYS.map((key) => [key, config.get<string>(key)])));
}

export const AI_CONFIG = Symbol('AI_CONFIG');
