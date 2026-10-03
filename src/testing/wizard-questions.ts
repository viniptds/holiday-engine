import type { LocalizedQuestionSet, LocalizedText } from '../wizard/wizard.types.js';

/** A localized text; the pt-BR and es texts default to the English one with a locale suffix. */
export const localized = (en: string, ptBR = `${en} (pt-BR)`, es = `${en} (es)`): LocalizedText => ({ en, 'pt-BR': ptBR, es });

/** A small question set, so specs don't depend on the bundled questions.json. */
export const TEST_QUESTIONS: LocalizedQuestionSet = {
  version: 1,
  questions: [
    {
      id: 'pace',
      title: localized('Pace?'),
      type: 'single',
      options: [
        { id: 'slow', label: localized('Slow'), icon: 's', tags: ['relaxer'] },
        { id: 'packed', label: localized('Packed'), icon: 'p', tags: ['adventurer'] },
      ],
    },
    {
      id: 'interests',
      title: localized('Interests?'),
      type: 'multi',
      max: 2,
      options: [
        { id: 'food', label: localized('Food'), icon: 'f', tags: ['foodie'] },
        { id: 'beach', label: localized('Beach'), icon: 'b', tags: ['relaxer'] },
        { id: 'hiking', label: localized('Hiking'), icon: 'h', tags: ['adventurer'] },
      ],
    },
  ],
  personas: {
    relaxer: localized('Easygoing Wanderer', 'Espírito tranquilo', 'Espíritu tranquilo'),
    foodie: localized('Taste Hunter', 'Paladar aventureiro', 'Paladar aventurero'),
    adventurer: localized('Trail Seeker', 'Pé na trilha', 'Alma senderista'),
  },
};
