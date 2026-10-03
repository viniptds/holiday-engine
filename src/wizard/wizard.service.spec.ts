import { AppError } from '../app-common/app-error.js';
import { WizardService } from './wizard.service.js';
import { computePersona } from './persona.js';
import type { QuestionSet } from './wizard.types.js';

const SET: QuestionSet = {
  version: 3,
  questions: [
    {
      id: 'pace',
      title: 'Pace?',
      type: 'single',
      options: [
        { id: 'slow', label: 'Slow', icon: 's', tags: ['relaxer'] },
        { id: 'packed', label: 'Packed', icon: 'p', tags: ['adventurer'] },
        { id: 'either', label: 'Either', icon: 'e' },
      ],
    },
    {
      id: 'interests',
      title: 'Interests?',
      type: 'multi',
      max: 2,
      options: [
        { id: 'food', label: 'Food', icon: 'f', tags: ['foodie'] },
        { id: 'beach', label: 'Beach', icon: 'b', tags: ['relaxer', 'foodie'] },
        { id: 'hiking', label: 'Hiking', icon: 'h', tags: ['adventurer'] },
        { id: 'shops', label: 'Shops', icon: 'x' },
      ],
    },
  ],
  // Order matters: ties go to the first listed.
  personas: { explorer: 'Curious Explorer', relaxer: 'Easygoing Wanderer', foodie: 'Taste Hunter', adventurer: 'Trail Seeker' },
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

  it('serves the loaded question set', () => {
    expect(wizard.getQuestionSet()).toBe(SET);
  });

  it('accepts valid answers, with questions left out, and adds the persona', () => {
    expect(build({ interests: ['food', 'hiking'] })).toEqual({
      questionSetVersion: 3,
      answers: { interests: ['food', 'hiking'] },
      persona: 'Taste Hunter',
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
    expect(computePersona(SET, { pace: ['slow'], interests: ['beach'] })).toBe('Easygoing Wanderer');
    // adventurer: packed + hiking = 2; foodie: food = 1
    expect(computePersona(SET, { pace: ['packed'], interests: ['hiking', 'food'] })).toBe('Trail Seeker');
  });

  it('breaks ties by the order of personas', () => {
    // relaxer 1 (slow), foodie 1 (food): relaxer is listed before foodie.
    expect(computePersona(SET, { pace: ['slow'], interests: ['food'] })).toBe('Easygoing Wanderer');
    // adventurer 1, foodie 1: foodie is listed first.
    expect(computePersona(SET, { pace: ['packed'], interests: ['food'] })).toBe('Taste Hunter');
  });

  it('is null when no chosen option has a tag', () => {
    expect(computePersona(SET, { pace: ['either'], interests: ['shops'] })).toBeNull();
    expect(computePersona(SET, {})).toBeNull();
  });
});
