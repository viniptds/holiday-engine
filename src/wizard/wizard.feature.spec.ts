import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { WizardModule } from './wizard.module.js';
import { loadQuestionSet } from './question-set.loader.js';
import { resolveQuestionSet } from './localize.js';
import type { LocalizedQuestionSet, QuestionSet } from './wizard.types.js';
import { localized } from '../testing/wizard-questions.js';
import { appDb } from '../testing/app-db.js';
import { accessTokens, appTestingModule, seedUser } from '../testing/app-testing.js';

const USER_ID = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
let AUTH: Record<string, string> = {};

const question = (n: number) => ({
  id: `q${n}`,
  title: localized(`Question ${n}`),
  type: n % 2 ? 'single' : 'multi',
  ...(n % 2 ? {} : { max: 2 }),
  options: [
    { id: 'a', label: localized('A'), icon: 'a', tags: ['calm'] },
    { id: 'b', label: localized('B'), icon: 'b' },
  ],
});
const setWith = (count: number): LocalizedQuestionSet =>
  ({
    version: 7,
    questions: Array.from({ length: count }, (_, i) => question(i + 1)),
    personas: { calm: localized('Calm One') },
  }) as LocalizedQuestionSet;

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

  it('serves the bundled question set by default, in English without Accept-Language', async () => {
    const served = await serve(undefined);
    app = served.app;

    const res = await fetch(served.url, { headers: AUTH });

    expect(res.status).toBe(200);
    const body = (await res.json()) as QuestionSet;
    expect(body).toEqual(resolveQuestionSet(loadQuestionSet(), 'en'));
    expect(body.questions[0]).toEqual({
      id: 'pace',
      title: "What's your travel pace?",
      type: 'single',
      options: [
        { id: 'slow', label: 'Slow and easy', icon: 'coffee', tags: ['relaxer'] },
        { id: 'balanced', label: 'A bit of both', icon: 'scale' },
        { id: 'packed', label: 'See it all', icon: 'zap', tags: ['explorer'] },
      ],
    });
  });

  // [Accept-Language, pace title, first interests label, budget "treat" label, relaxer persona]
  it.each([
    ['en', "What's your travel pace?", 'Food', 'Treat yourself', 'Easygoing Wanderer'],
    ['pt-BR', 'Qual é o seu ritmo de viagem?', 'Comida', 'Me dar um mimo', 'Espírito tranquilo'],
    ['es', '¿Cuál es tu ritmo de viaje?', 'Comida', 'Darme un gusto', 'Espíritu tranquilo'],
    ['es-AR,es;q=0.9,en;q=0.8', '¿Cuál es tu ritmo de viaje?', 'Comida', 'Darme un gusto', 'Espíritu tranquilo'],
    ['pt-PT', 'Qual é o seu ritmo de viagem?', 'Comida', 'Me dar um mimo', 'Espírito tranquilo'],
    ['fr', "What's your travel pace?", 'Food', 'Treat yourself', 'Easygoing Wanderer'],
    ['de-DE,fr;q=0.8', "What's your travel pace?", 'Food', 'Treat yourself', 'Easygoing Wanderer'],
  ])('serves Accept-Language %p in its locale', async (language, paceTitle, food, treat, relaxer) => {
    const served = await serve(undefined);
    app = served.app;

    const res = await fetch(served.url, { headers: { ...AUTH, 'accept-language': language } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as QuestionSet;
    expect(body.questions[0].title).toBe(paceTitle);
    expect(body.questions[1].options[0].label).toBe(food);
    expect(body.questions[2].options[2].label).toBe(treat);
    expect(body.personas.relaxer).toBe(relaxer);
    // Plain strings, as before localization.
    expect(typeof body.questions[0].options[0].label).toBe('string');
  });

  it('keeps ids, icons, tags and version identical in every language', async () => {
    const served = await serve(undefined);
    app = served.app;
    const structure = async (language: string) => {
      const body = (await (await fetch(served.url, { headers: { ...AUTH, 'accept-language': language } })).json()) as QuestionSet;
      return {
        version: body.version,
        questions: body.questions.map(({ title: _, options, ...q }) => ({ ...q, options: options.map(({ label: __, ...o }) => o) })),
        personas: Object.keys(body.personas),
      };
    };

    const en = await structure('en');
    expect(await structure('pt-BR')).toEqual(en);
    expect(await structure('es')).toEqual(en);
    expect(en.version).toBe(1);
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

    expect(body).toEqual(resolveQuestionSet(setWith(count), 'en'));
    expect(body.questions).toHaveLength(count);
  });

  it('fails startup with the file and the problems when the file is invalid', async () => {
    const path = join(dir, 'six.json');
    writeFileSync(path, JSON.stringify(setWith(6)));

    await expect(serve(path)).rejects.toThrow(`Invalid wizard question set (${path}): questions must have 1-5 entries (has 6)`);
  });

  it('fails startup naming every missing translation', async () => {
    const path = join(dir, 'untranslated.json');
    const set = setWith(2) as Record<string, any>;
    delete set.questions[1].options[1].label.es;
    delete set.personas.calm['pt-BR'];
    set.questions[0].title = 'Question 1';
    writeFileSync(path, JSON.stringify(set));

    await expect(serve(path)).rejects.toThrow(
      `Invalid wizard question set (${path}): personas.calm is missing "pt-BR"; ` +
        'questions[0].title must be an object with a text for each locale ("en", "pt-BR", "es"); ' +
        'questions[1].options[1].label is missing "es"',
    );
  });
});
