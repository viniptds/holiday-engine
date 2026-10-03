import { readAiConfig } from './ai.config.js';
import { createLlmProvider, createPlacesProvider } from './ai.module.js';

describe('readAiConfig', () => {
  it('defaults to the mock providers with the spec defaults', () => {
    expect(readAiConfig({})).toEqual({
      provider: 'mock',
      model: 'mock',
      apiKey: '',
      timeoutMs: 30_000,
      maxTokens: 4096,
      effort: 'low',
      placesProvider: 'mock',
      placesApiKey: '',
    });
  });

  it('uses claude-sonnet-5-5 by default for anthropic, and AI_MODEL when set', () => {
    expect(readAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-x' })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'sk-ant-x',
    });
    expect(readAiConfig({ AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', AI_MODEL: 'claude-opus-5-5' }).model).toBe('claude-opus-5-5');
  });

  it('switches to openai with its own key and a required model', () => {
    expect(readAiConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o', AI_MODEL: 'gpt-x' })).toMatchObject({
      provider: 'openai',
      model: 'gpt-x',
      apiKey: 'sk-o',
    });
    expect(() => readAiConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-o' })).toThrow('AI_MODEL is required');
  });

  it.each([
    [{ AI_PROVIDER: 'anthropic' }, 'ANTHROPIC_API_KEY is required'],
    [{ AI_PROVIDER: 'anthropic', OPENAI_API_KEY: 'sk-o' }, 'ANTHROPIC_API_KEY is required'],
    [{ AI_PROVIDER: 'openai', AI_MODEL: 'gpt-x' }, 'OPENAI_API_KEY is required'],
    [{ PLACES_PROVIDER: 'google' }, 'GOOGLE_PLACES_API_KEY is required'],
  ])('fails startup on a missing key: %j', (env, message) => {
    expect(() => readAiConfig(env)).toThrow(message);
  });

  it('refuses mock providers in production', () => {
    const real = { AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k', PLACES_PROVIDER: 'google', GOOGLE_PLACES_API_KEY: 'g' };
    expect(() => readAiConfig({ NODE_ENV: 'production' })).toThrow('AI_PROVIDER=mock is not allowed in production');
    expect(() => readAiConfig({ ...real, NODE_ENV: 'production', PLACES_PROVIDER: 'mock' })).toThrow(
      'PLACES_PROVIDER=mock is not allowed in production',
    );
    expect(readAiConfig({ ...real, NODE_ENV: 'production' }).provider).toBe('anthropic');
  });

  it.each([
    [{ AI_PROVIDER: 'gemini' }, 'AI_PROVIDER must be one of'],
    [{ AI_EFFORT: 'huge' }, 'AI_EFFORT must be one of'],
    [{ AI_TIMEOUT_MS: '0' }, 'AI_TIMEOUT_MS must be a positive integer'],
    [{ AI_MAX_TOKENS: 'lots' }, 'AI_MAX_TOKENS must be a positive integer'],
  ])('rejects bad values: %j', (env, message) => {
    expect(() => readAiConfig(env)).toThrow(message);
  });

  it('never puts a key value in its errors', () => {
    expect(() => readAiConfig({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-secret-123' })).toThrow(/^((?!sk-secret-123).)*$/);
  });
});

describe('provider factories', () => {
  const base = readAiConfig({});

  it('builds the selected LLM provider', () => {
    expect(createLlmProvider(base).name).toBe('mock');
    expect(createLlmProvider({ ...base, provider: 'anthropic', apiKey: 'k', model: 'claude-sonnet-5-5' }).name).toBe('anthropic');
    expect(createLlmProvider({ ...base, provider: 'openai', apiKey: 'k', model: 'gpt-x' }).name).toBe('openai');
  });

  it('builds the selected places provider', () => {
    expect(createPlacesProvider(base).name).toBe('mock');
    expect(createPlacesProvider({ ...base, placesProvider: 'google', placesApiKey: 'g' }).name).toBe('google');
  });
});
