import 'reflect-metadata';
import { MODEL_DRAFT_SCHEMA, normalizeDraft, normalizeName, parseModelDraft, replayText } from './draft.js';
import type { ModelDraft } from './draft.js';

const model = (overrides: Partial<ModelDraft> = {}): ModelDraft => ({
  reply: 'Here is a plan',
  destination: 'Lisbon',
  startDate: '2026-11-10',
  endDate: '2026-11-14',
  partyType: 'friends',
  partySize: 3,
  story: 'Food and views',
  places: [{ name: 'Time Out Market', category: 'food', day: 1, why: 'Lots of local food' }],
  questions: [],
  travelerAnswers: [],
  ...overrides,
});

describe('MODEL_DRAFT_SCHEMA', () => {
  type Node = Record<string, unknown>;
  const objects = (node: unknown, found: Node[] = []): Node[] => {
    if (node && typeof node === 'object') {
      if ((node as Node).type === 'object') found.push(node as Node);
      for (const value of Object.values(node)) objects(value, found);
    }
    return found;
  };

  it('is strict-mode friendly: every object closed with all properties required', () => {
    for (const object of objects(MODEL_DRAFT_SCHEMA)) {
      expect(object.additionalProperties).toBe(false);
      expect([...(object.required as string[])].sort()).toEqual(Object.keys(object.properties as Node).sort());
    }
  });

  it('uses no length or numeric constraints (unsupported by structured outputs)', () => {
    const text = JSON.stringify(MODEL_DRAFT_SCHEMA);
    for (const keyword of ['minLength', 'maxLength', 'minimum', 'maximum', 'maxItems', 'minItems', 'pattern']) {
      expect(text).not.toContain(`"${keyword}"`);
    }
  });
});

describe('parseModelDraft', () => {
  it('accepts a well-formed draft', async () => {
    await expect(parseModelDraft(model())).resolves.toEqual({ draft: model() });
  });

  it('treats missing nullable fields as null', async () => {
    const { destination: _d, story: _s, ...rest } = model();
    await expect(parseModelDraft(rest)).resolves.toMatchObject({ draft: { destination: null, story: null } });
  });

  it.each([
    ['a non-object', 'nope', 'the reply must be a JSON object'],
    ['an array', [], 'the reply must be a JSON object'],
    ['a missing reply', { ...model(), reply: undefined }, 'reply'],
    ['a wrong category', { ...model(), places: [{ name: 'X', category: 'museum', day: null, why: '' }] }, 'places.0.category'],
    ['a fractional party size', { ...model(), partySize: 2.5 }, 'partySize'],
    ['an unknown party type', { ...model(), partyType: 'crew' }, 'partyType'],
    ['questions that are not strings', { ...model(), questions: [1] }, 'questions'],
  ])('names the problem with %s', async (_label, value, problem) => {
    const result = await parseModelDraft(value);
    expect(result).toHaveProperty('problem');
    expect((result as { problem: string }).problem).toContain(problem);
  });
});

describe('normalizeDraft', () => {
  it('is ready with a destination and a valid date range; places start unverified', () => {
    expect(normalizeDraft(model())).toEqual({
      ready: true,
      destination: 'Lisbon',
      startDate: '2026-11-10',
      endDate: '2026-11-14',
      partyType: 'friends',
      partySize: 3,
      story: 'Food and views',
      places: [{ name: 'Time Out Market', category: 'food', day: 1, why: 'Lots of local food', verified: false, place: null }],
      questions: [],
      travelerAnswers: {},
    });
  });

  it('keeps the stated traveler answers (unchecked here; the service checks them)', () => {
    expect(normalizeDraft(model({ travelerAnswers: [{ questionId: 'pace', optionIds: ['slow'] }] })).travelerAnswers).toEqual({
      pace: ['slow'],
    });
    expect(normalizeDraft(model({ travelerAnswers: undefined })).travelerAnswers).toEqual({});
  });

  it.each([
    ['no destination', { destination: null }],
    ['a blank destination', { destination: '   ' }],
    ['no end date', { endDate: null }],
    ['end before start', { startDate: '2026-11-14', endDate: '2026-11-10' }],
    ['more than 365 days', { startDate: '2026-01-01', endDate: '2027-01-02' }],
  ])('is not ready with %s', (_label, overrides) => {
    expect(normalizeDraft(model(overrides)).ready).toBe(false);
  });

  it('drops malformed and impossible dates', () => {
    const draft = normalizeDraft(model({ startDate: '2026-02-30', endDate: 'next friday' }));
    expect(draft).toMatchObject({ startDate: null, endDate: null, ready: false });
  });

  it('keeps 365 days as valid', () => {
    expect(normalizeDraft(model({ startDate: '2026-01-01', endDate: '2027-01-01' })).ready).toBe(true);
  });

  it('cuts text to the column sizes and strips control characters', () => {
    const draft = normalizeDraft(
      model({ destination: `Lis\u0000bon ${'x'.repeat(200)}`, story: `line1\nline2\u0007${'y'.repeat(1200)}` }),
    );
    expect(draft.destination).toHaveLength(100);
    expect(draft.destination!.startsWith('Lis bon')).toBe(true);
    expect(draft.story!.startsWith('line1\nline2y')).toBe(true);
    expect(draft.story).toHaveLength(1000);
  });

  it('caps places at 15, de-duplicates names and clears days outside the trip', () => {
    const places = Array.from({ length: 20 }, (_, i) => ({ name: `Place ${i}`, category: 'sight' as const, day: i + 1, why: '' }));
    const draft = normalizeDraft(model({ places: [{ name: 'place 0!', category: 'food', day: 1, why: '' }, ...places] }));

    expect(draft.places).toHaveLength(15);
    expect(draft.places[0].name).toBe('place 0!');
    expect(draft.places.map((p) => p.name)).not.toContain('Place 0');
    // The trip is 5 days long.
    expect(draft.places.find((p) => p.name === 'Place 5')!.day).toBeNull();
    expect(draft.places.find((p) => p.name === 'Place 4')!.day).toBe(5);
  });

  it('nulls out-of-range party sizes and caps questions at 3', () => {
    const draft = normalizeDraft(model({ partySize: 40, questions: ['a?', 'b?', ' ', 'c?', 'd?'] }));
    expect(draft.partySize).toBeNull();
    expect(draft.questions).toEqual(['a?', 'b?', 'c?']);
  });
});

describe('normalizeName', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeName('  Pastéis de Belém! ')).toBe(normalizeName('pasteis de belem'));
  });
});

describe('replayText', () => {
  it('rebuilds the model JSON from a stored turn, without verification data', () => {
    const draft = normalizeDraft(model());
    draft.places[0] = { ...draft.places[0], verified: true, place: { googlePlaceId: 'g1', name: 'Mercado', address: 'a', lat: 1, lng: 2, rating: null, types: [], mapsUrl: null } };

    expect(JSON.parse(replayText('Here is a plan', draft))).toEqual(model());
    expect(replayText('Here is a plan', draft)).toBe(replayText('Here is a plan', draft));
  });

  it('replays traveler answers, and none for drafts stored before they existed', () => {
    const draft = normalizeDraft(model({ travelerAnswers: [{ questionId: 'interests', optionIds: ['food', 'beach'] }] }));
    expect(JSON.parse(replayText('Hi', draft)).travelerAnswers).toEqual([{ questionId: 'interests', optionIds: ['food', 'beach'] }]);
    delete draft.travelerAnswers;
    expect(JSON.parse(replayText('Hi', draft)).travelerAnswers).toEqual([]);
  });

  it('parses a reply without travelerAnswers as none, and rejects a malformed list', async () => {
    const { travelerAnswers: _omit, ...withoutAnswers } = model();
    expect(await parseModelDraft(withoutAnswers)).toMatchObject({ draft: { travelerAnswers: [] } });
    expect(await parseModelDraft({ ...model(), travelerAnswers: [{ questionId: 'pace', optionIds: 'slow' }] })).toHaveProperty('problem');
  });
});
