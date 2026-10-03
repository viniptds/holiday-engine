import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUESTIONS_PATH, loadQuestionSet, parseQuestionSet } from './question-set.loader.js';

const option = (id: string, tags?: string[]) => ({ id, label: `Label ${id}`, icon: 'i', ...(tags ? { tags } : {}) });
const single = (id: string) => ({ id, title: `Title ${id}`, type: 'single', options: [option('a', ['x']), option('b')] });
const multi = (id: string, max = 2) => ({
  id,
  title: `Title ${id}`,
  type: 'multi',
  max,
  options: [option('a', ['x']), option('b', ['y']), option('c')],
});
const valid = () => ({ version: 1, questions: [single('q1'), multi('q2')], personas: { x: 'Persona X', y: 'Persona Y' } });

/** `valid()` with `change` applied, parsed; returns the error message. */
function problemsWith(change: (set: ReturnType<typeof valid> & Record<string, unknown>) => void): string {
  const set = valid();
  change(set);
  try {
    parseQuestionSet(set);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected the question set to be rejected');
}

describe('parseQuestionSet', () => {
  it('accepts a valid set, returning only contract fields', () => {
    const raw = { ...valid(), extra: true };
    (raw.questions[0] as Record<string, unknown>).hint = 'not in the contract';

    const set = parseQuestionSet(raw);

    expect(set).toEqual(valid());
    expect(set.questions[0]).not.toHaveProperty('hint');
  });

  it.each<[string, (set: Record<string, any>) => void, string]>([
    ['no questions', (s) => (s.questions = []), 'questions must have 1-5 entries (has 0)'],
    [
      'six questions',
      (s) => (s.questions = ['a', 'b', 'c', 'd', 'e', 'f'].map(single)),
      'questions must have 1-5 entries (has 6)',
    ],
    ['a duplicate question id', (s) => (s.questions[1].id = 'q1'), 'question id "q1" is used more than once'],
    ['a duplicate option id', (s) => (s.questions[1].options[2].id = 'a'), 'question "q2": option id "a" is used more than once'],
    ['an unknown type', (s) => (s.questions[0].type = 'text'), 'question "q1": type must be "single" or "multi"'],
    ['a multi without max', (s) => delete s.questions[1].max, 'question "q2": a multi question needs max between 1 and its number of options (3)'],
    ['a multi with max 0', (s) => (s.questions[1].max = 0), 'question "q2": a multi question needs max between 1'],
    ['a multi with max above its options', (s) => (s.questions[1].max = 4), 'question "q2": a multi question needs max between 1'],
    ['a single with max', (s) => (s.questions[0].max = 1), 'question "q1": max only applies to multi questions'],
    ['an empty title', (s) => (s.questions[0].title = ' '), 'question "q1": title must be a non-empty string'],
    ['an empty option label', (s) => (s.questions[0].options[0].label = ''), 'question "q1" option "a": label must be a non-empty string'],
    ['a missing option icon', (s) => delete s.questions[0].options[0].icon, 'question "q1" option "a": icon must be a non-empty string'],
    ['a missing question id', (s) => delete s.questions[0].id, 'questions[0].id must be a non-empty string'],
    ['no options', (s) => (s.questions[0].options = []), 'question "q1": options must be a non-empty array'],
    ['a tag missing from personas', (s) => (s.questions[0].options[0].tags = ['z']), 'question "q1" option "a": tag "z" is not a key of personas'],
    ['an empty persona label', (s) => (s.personas.y = ''), 'personas.y must be a non-empty label'],
    ['no personas', (s) => (s.personas = {}), 'personas must be a non-empty object'],
    ['a non-integer version', (s) => (s.version = '1'), 'version must be a positive integer'],
  ])('rejects %s', (_label, change, message) => {
    expect(problemsWith(change)).toContain(message);
  });

  it('lists every problem at once', () => {
    const message = problemsWith((s: Record<string, any>) => {
      s.version = 0;
      s.questions[0].type = 'text';
      s.questions[1].options[0].label = '';
    });

    expect(message.split('; ')).toHaveLength(3);
  });

  it('rejects a non-object', () => {
    expect(() => parseQuestionSet([])).toThrow('the question set must be a JSON object');
  });
});

describe('loadQuestionSet', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wizard-questions-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads the bundled question set by default', () => {
    expect(DEFAULT_QUESTIONS_PATH).toMatch(/wizard[/\\]questions\.json$/);
    const set = loadQuestionSet();

    expect(set.version).toBe(1);
    expect(set.questions.map((q) => [q.id, q.type, q.max, q.options.map((o) => o.id)])).toEqual([
      ['pace', 'single', undefined, ['slow', 'balanced', 'packed']],
      ['interests', 'multi', 3, ['food', 'culture', 'nature', 'beach', 'nightlife']],
      ['budget', 'single', undefined, ['saver', 'comfort', 'treat']],
    ]);
    expect(set.personas).toEqual({
      relaxer: 'Easygoing Wanderer',
      explorer: 'Curious Explorer',
      foodie: 'Taste Hunter',
      adventurer: 'Trail Seeker',
    });
  });

  it('names the file in its errors', () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ ...valid(), questions: [] }));

    expect(() => loadQuestionSet(path)).toThrow(`Invalid wizard question set (${path}): questions must have 1-5 entries`);
  });

  it('reports malformed JSON and a missing file', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ "version": ');

    expect(() => loadQuestionSet(path)).toThrow(`Invalid wizard question set (${path}):`);
    expect(() => loadQuestionSet(join(dir, 'missing.json'))).toThrow(/Invalid wizard question set .*ENOENT/);
  });
});
