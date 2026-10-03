import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { WizardModule } from './wizard.module.js';
import { loadQuestionSet } from './question-set.loader.js';
import type { QuestionSet } from './wizard.types.js';
import { appDb } from '../testing/app-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';

const USER_ID = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
let AUTH: Record<string, string> = {};

const question = (n: number) => ({
  id: `q${n}`,
  title: `Question ${n}`,
  type: n % 2 ? 'single' : 'multi',
  ...(n % 2 ? {} : { max: 2 }),
  options: [
    { id: 'a', label: 'A', icon: 'a', tags: ['calm'] },
    { id: 'b', label: 'B', icon: 'b' },
  ],
});
const setWith = (count: number): QuestionSet =>
  ({ version: 7, questions: Array.from({ length: count }, (_, i) => question(i + 1)), personas: { calm: 'Calm One' } }) as QuestionSet;

/** Boots WizardModule over HTTP with WIZARD_QUESTIONS_PATH set (or unset), the way the app reads it. */
async function serve(path: string | undefined): Promise<{ app: INestApplication; url: string }> {
  if (path === undefined) delete process.env.WIZARD_QUESTIONS_PATH;
  else process.env.WIZARD_QUESTIONS_PATH = path;
  const db = appDb();
  seedUser(db, USER_ID);
  const moduleRef = await appTestingModule(db, [WizardModule]).compile();
  AUTH = { authorization: `Bearer ${(await accessTokens(moduleRef, [USER_ID]))[USER_ID]}` };
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, url: `${await app.getUrl()}/app/v1/wizard/questions` };
}

describe('GET /app/v1/wizard/questions (feature)', () => {
  const env = process.env.WIZARD_QUESTIONS_PATH;
  let dir: string;
  let app: INestApplication | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wizard-feature-'));
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    if (env === undefined) delete process.env.WIZARD_QUESTIONS_PATH;
    else process.env.WIZARD_QUESTIONS_PATH = env;
  });

  it('serves the bundled question set by default', async () => {
    const served = await serve(undefined);
    app = served.app;

    const res = await fetch(served.url, { headers: AUTH });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(loadQuestionSet());
  });

  it('requires authentication', async () => {
    const served = await serve(undefined);
    app = served.app;

    const res = await fetch(served.url);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED', message: 'Missing access token' });
  });

  it.each([1, 5])('serves a %i-question file from WIZARD_QUESTIONS_PATH with no code change', async (count) => {
    const path = join(dir, `questions-${count}.json`);
    writeFileSync(path, JSON.stringify(setWith(count)));
    const served = await serve(path);
    app = served.app;

    const body = (await (await fetch(served.url, { headers: AUTH })).json()) as QuestionSet;

    expect(body).toEqual(setWith(count));
    expect(body.questions).toHaveLength(count);
  });

  it('fails startup with the file and the problems when the file is invalid', async () => {
    const path = join(dir, 'six.json');
    writeFileSync(path, JSON.stringify(setWith(6)));

    await expect(serve(path)).rejects.toThrow(`Invalid wizard question set (${path}): questions must have 1-5 entries (has 6)`);
  });
});
