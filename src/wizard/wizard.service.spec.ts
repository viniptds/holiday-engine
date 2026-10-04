import { AppError } from '../app-common/app-error.js';
import { WizardService } from './wizard.service.js';
import { computePersona, personaKey, personaLabel } from './persona.js';
import type { LocalizedQuestionSet } from './wizard.types.js';
import { localized } from '../testing/wizard-questions.js';

const SET: LocalizedQuestionSet = {
  version: 3,
  questions: [
    {
      id: 'pace',
      title: localized('Pace?'),
      type: 'single',
      options: [
        { id: 'slow', label: localized('Slow'), icon: 's', tags: ['relaxer'] },
        { id: 'packed', label: localized('Packed'), icon: 'p', tags: ['adventurer'] },
        { id: 'either', label: localized('Either'), icon: 'e' },
      ],
    },
    {
      id: 'interests',
      title: localized('Interests?'),
      type: 'multi',
      max: 2,
      options: [
        { id: 'food', label: localized('Food'), icon: 'f', tags: ['foodie'] },
        { id: 'beach', label: localized('Beach'), icon: 'b', tags: ['relaxer', 'foodie'] },
        { id: 'hiking', label: localized('Hiking'), icon: 'h', tags: ['adventurer'] },
        { id: 'shops', label: localized('Shops'), icon: 'x' },
      ],
    },
  ],
  // Order matters: ties go to the first listed.
  personas: {
    explorer: localized('Curious Explorer', 'Curiosidade sem fim', 'Curiosidad sin fin'),
    relaxer: localized('Easygoing Wanderer', 'Espírito tranquilo', 'Espíritu tranquilo'),
    foodie: localized('Taste Hunter', 'Paladar aventureiro', 'Paladar aventurero'),
    adventurer: localized('Trail Seeker', 'Pé na trilha', 'Alma senderista'),
  },
};

describe('WizardService.buildProfile', () => {
  const wizard = new WizardService(SET);
  const build = (answers: Record<string, string[]>, questionSetVersion = 3) =>
    wizard.buildProfile({ questionSetVersion, answers });

  /** The VALIDATION fields `build` throws. */
  function fieldsOf(answers: Record<string, string[]>, questionSetVersion = 3): Record<string, string> {
    try {
      build(answers, questionSetVersion);
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION');
      return (error as AppError).fields!;
    }
    throw new Error('expected VALIDATION');
  }

  it('accepts valid answers, with questions left out, and adds the persona key', () => {
    expect(build({ interests: ['food', 'hiking'] })).toEqual({
      questionSetVersion: 3,
      answers: { interests: ['food', 'hiking'] },
      persona: 'foodie',
    });
    expect(build({})).toEqual({ questionSetVersion: 3, answers: {}, persona: null });
  });

  it('rejects a version other than the current one', () => {
    expect(fieldsOf({}, 2)).toEqual({ 'travelerProfile.questionSetVersion': 'questionSetVersion must be 3, the current version' });
  });

  it('rejects an unknown question', () => {
    expect(fieldsOf({ budget: ['saver'] })).toEqual({ 'travelerProfile.answers.budget': 'budget is not a known question' });
  });

  it('rejects an unknown option', () => {
    expect(fieldsOf({ pace: ['fast'] })).toEqual({ 'travelerProfile.answers.pace': 'fast is not an option of pace' });
    expect(fieldsOf({ interests: ['food', 'golf', 'ski'] })).toEqual({
      'travelerProfile.answers.interests': 'golf, ski are not options of interests',
    });
  });

  it('rejects an option of another question', () => {
    expect(fieldsOf({ pace: ['food'] })).toEqual({ 'travelerProfile.answers.pace': 'food is not an option of pace' });
  });

  it('takes exactly 1 value for a single question', () => {
    expect(fieldsOf({ pace: [] })).toEqual({ 'travelerProfile.answers.pace': 'pace takes exactly 1 option' });
    expect(fieldsOf({ pace: ['slow', 'packed'] })).toEqual({ 'travelerProfile.answers.pace': 'pace takes exactly 1 option' });
  });

  it('takes 1..max values for a multi question', () => {
    expect(fieldsOf({ interests: [] })).toEqual({ 'travelerProfile.answers.interests': 'interests takes 1 to 2 options' });
    expect(fieldsOf({ interests: ['food', 'beach', 'hiking'] })).toEqual({
      'travelerProfile.answers.interests': 'interests takes 1 to 2 options',
    });
    expect(build({ interests: ['shops'] }).answers).toEqual({ interests: ['shops'] });
  });

  it('rejects a duplicate value', () => {
    expect(fieldsOf({ interests: ['food', 'food'] })).toEqual({
      'travelerProfile.answers.interests': 'interests must not repeat an option',
    });
    expect(fieldsOf({ pace: ['slow', 'slow'] })).toEqual({ 'travelerProfile.answers.pace': 'pace must not repeat an option' });
  });

  it('reports every problem at once', () => {
    expect(Object.keys(fieldsOf({ pace: ['fast'], mood: ['x'], interests: [] }, 1)).sort()).toEqual([
      'travelerProfile.answers.interests',
      'travelerProfile.answers.mood',
      'travelerProfile.answers.pace',
      'travelerProfile.questionSetVersion',
    ]);
  });

  it('does not treat inherited keys as questions', () => {
    expect(fieldsOf(JSON.parse('{"__proto__": ["x"], "constructor": ["y"]}'))).toEqual({
      'travelerProfile.answers.__proto__': '__proto__ is not a known question',
      'travelerProfile.answers.constructor': 'constructor is not a known question',
    });
  });
});

describe('computePersona', () => {
  it('picks the tag chosen most often across questions', () => {
    // relaxer: slow + beach = 2; foodie: beach = 1
    expect(computePersona(SET, { pace: ['slow'], interests: ['beach'] })).toBe('relaxer');
    // adventurer: packed + hiking = 2; foodie: food = 1
    expect(computePersona(SET, { pace: ['packed'], interests: ['hiking', 'food'] })).toBe('adventurer');
  });

  it('breaks ties by the order of personas', () => {
    // relaxer 1 (slow), foodie 1 (food): relaxer is listed before foodie.
    expect(computePersona(SET, { pace: ['slow'], interests: ['food'] })).toBe('relaxer');
    // adventurer 1, foodie 1: foodie is listed first.
    expect(computePersona(SET, { pace: ['packed'], interests: ['food'] })).toBe('foodie');
  });

  it('is null when no chosen option has a tag', () => {
    expect(computePersona(SET, { pace: ['either'], interests: ['shops'] })).toBeNull();
    expect(computePersona(SET, {})).toBeNull();
  });
});

describe('WizardService.getQuestionSet', () => {
  const wizard = new WizardService(SET);

  it.each([
    ['en', 'Pace?', 'Slow', 'Taste Hunter'],
    ['pt-BR', 'Pace? (pt-BR)', 'Slow (pt-BR)', 'Paladar aventureiro'],
    ['es', 'Pace? (es)', 'Slow (es)', 'Paladar aventurero'],
  ] as const)('resolves every text to %s', (locale, title, label, foodie) => {
    const set = wizard.getQuestionSet(locale);

    expect(set.questions[0].title).toBe(title);
    expect(set.questions[0].options[0]).toEqual({ id: 'slow', label, icon: 's', tags: ['relaxer'] });
    expect(set.personas.foodie).toBe(foodie);
  });

  it('keeps ids, icons, tags, max, version and persona order the same in every language', () => {
    const structure = (locale: 'en' | 'pt-BR' | 'es') => {
      const set = wizard.getQuestionSet(locale);
      return {
        version: set.version,
        questions: set.questions.map((q) => ({ id: q.id, type: q.type, max: q.max, options: q.options.map(({ label: _, ...o }) => o) })),
        personas: Object.keys(set.personas),
      };
    };

    expect(structure('pt-BR')).toEqual(structure('en'));
    expect(structure('es')).toEqual(structure('en'));
    expect(structure('en').personas).toEqual(['explorer', 'relaxer', 'foodie', 'adventurer']);
    expect(wizard.getQuestionSet('en').questions[0]).not.toHaveProperty('max');
  });
});

describe('WizardService.presentProfile / normalizeProfile', () => {
  const wizard = new WizardService(SET);
  const profile = (persona: string | null) => ({ questionSetVersion: 3, answers: { pace: ['slow'] }, persona });

  it('returns the persona label in the locale, for a key or a legacy label', () => {
    expect(wizard.presentProfile(profile('relaxer'), 'es')).toEqual(profile('Espíritu tranquilo'));
    expect(wizard.presentProfile(profile('Easygoing Wanderer'), 'pt-BR')).toEqual(profile('Espírito tranquilo'));
    expect(wizard.presentProfile(profile(null), 'es')).toEqual(profile(null));
    expect(wizard.presentProfile(profile('Someone Else'), 'en')).toEqual(profile(null));
    expect(wizard.presentProfile(null, 'en')).toBeNull();
  });

  it('normalizes a legacy label to its key and keeps keys, null and unknown values', () => {
    expect(wizard.normalizeProfile(profile('Trail Seeker'))).toEqual(profile('adventurer'));
    expect(wizard.normalizeProfile(profile('adventurer'))).toEqual(profile('adventurer'));
    expect(wizard.normalizeProfile(profile(null))).toEqual(profile(null));
    expect(wizard.normalizeProfile(profile('Someone Else'))).toEqual(profile('Someone Else'));
    expect(wizard.normalizeProfile(null)).toBeNull();
  });
});

describe('personaKey / personaLabel', () => {
  it('maps a key or a label in any locale to the key', () => {
    expect(personaKey(SET, 'foodie')).toBe('foodie');
    expect(personaKey(SET, 'Taste Hunter')).toBe('foodie');
    expect(personaKey(SET, 'Paladar aventureiro')).toBe('foodie');
    expect(personaKey(SET, 'Curiosidad sin fin')).toBe('explorer');
    expect(personaKey(SET, 'taste hunter')).toBeNull();
    expect(personaKey(SET, 'constructor')).toBeNull();
  });

  it('gives the label in the locale, or null for null and unknown values', () => {
    expect(personaLabel(SET, 'Taste Hunter', 'es')).toBe('Paladar aventurero');
    expect(personaLabel(SET, 'adventurer', 'pt-BR')).toBe('Pé na trilha');
    expect(personaLabel(SET, null, 'en')).toBeNull();
    expect(personaLabel(SET, 'Unknown', 'en')).toBeNull();
  });
});

describe('WizardService answers proposed by the AI planner', () => {
  const wizard = new WizardService(SET);

  it('keeps only known questions and options, without repeats, capped per question', () => {
    expect(
      wizard.sanitizeAnswers({
        pace: ['slow', 'packed'],
        interests: ['food', 'food', 'golf', 'beach', 'hiking'],
        budget: ['saver'],
        mood: [],
      }),
    ).toEqual({ pace: ['slow'], interests: ['food', 'beach'] });
    expect(wizard.sanitizeAnswers({ pace: ['fast'], interests: 'food' as never })).toEqual({});
  });

  it('describes the questions by id for the prompt, and gives the version', () => {
    expect(wizard.plannerQuestions()).toEqual([
      { id: 'pace', title: 'Pace?', type: 'single', optionIds: ['slow', 'packed', 'either'] },
      { id: 'interests', title: 'Interests?', type: 'multi', max: 2, optionIds: ['food', 'beach', 'hiking', 'shops'] },
    ]);
    expect(wizard.version).toBe(3);
  });
});
