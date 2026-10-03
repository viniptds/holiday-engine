import { aiDb, aiTestingModule } from './testing/ai-db.js';
import { LLM_PROVIDER } from './llm/llm-provider.js';
import type { LlmProvider } from './llm/llm-provider.js';
import { PLACES_PROVIDER } from './places/places-provider.js';
import type { PlacesProvider } from './places/places-provider.js';

describe('AiModule startup', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
  });

  it('starts with the mock providers by default', async () => {
    const moduleRef = await aiTestingModule(aiDb()).compile();
    expect(moduleRef.get<LlmProvider>(LLM_PROVIDER).name).toBe('mock');
    expect(moduleRef.get<PlacesProvider>(PLACES_PROVIDER).name).toBe('mock');
    await moduleRef.close();
  });

  it('switches providers from the environment', async () => {
    const moduleRef = await aiTestingModule(aiDb(), {
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test',
      AI_MODEL: 'gpt-x',
      PLACES_PROVIDER: 'google',
      GOOGLE_PLACES_API_KEY: 'places-test',
    }).compile();
    expect(moduleRef.get<LlmProvider>(LLM_PROVIDER).name).toBe('openai');
    expect(moduleRef.get<PlacesProvider>(PLACES_PROVIDER).name).toBe('google');
    await moduleRef.close();
  });

  it('fails when the selected provider has no key', async () => {
    await expect(aiTestingModule(aiDb(), { AI_PROVIDER: 'anthropic' }).compile()).rejects.toThrow(
      'ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
    );
  });

  it('fails with mock providers in production', async () => {
    process.env.NODE_ENV = 'production';
    await expect(aiTestingModule(aiDb()).compile()).rejects.toThrow('AI_PROVIDER=mock is not allowed in production');
  });
});
