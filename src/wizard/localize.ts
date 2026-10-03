import type { Locale } from '../app-common/locale.js';
import type { LocalizedQuestionSet, Question, QuestionSet } from './wizard.types.js';

/**
 * The contract `QuestionSet` in `locale`: every title and label picked in that language. Ids,
 * icons, tags, max and version are the same in every language. Returns fresh objects.
 */
export function resolveQuestionSet(set: LocalizedQuestionSet, locale: Locale): QuestionSet {
  return {
    version: set.version,
    questions: set.questions.map((q) => {
      const question: Question = {
        id: q.id,
        title: q.title[locale],
        type: q.type,
        options: q.options.map((o) => ({
          id: o.id,
          label: o.label[locale],
          icon: o.icon,
          ...(o.tags ? { tags: [...o.tags] } : {}),
        })),
      };
      if (q.max !== undefined) question.max = q.max;
      return question;
    }),
    personas: Object.fromEntries(Object.entries(set.personas).map(([key, label]) => [key, label[locale]])),
  };
}
