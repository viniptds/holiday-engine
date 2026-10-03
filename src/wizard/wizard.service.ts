import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { TravelerProfile } from '../app-trips/app-trips.types.js';
import { QUESTION_SET } from './wizard.types.js';
import type { QuestionSet } from './wizard.types.js';
import { computePersona } from './persona.js';

/** `travelerProfile` as clients send it: the persona is always computed here. */
export type TravelerProfileInput = { questionSetVersion: number; answers: Record<string, string[]> };

const FIELD = 'travelerProfile';

@Injectable()
export class WizardService {
  constructor(@Inject(QUESTION_SET) private readonly set: QuestionSet) {}

  getQuestionSet(): QuestionSet {
    return this.set;
  }

  /**
   * Validates a client profile against the current question set and returns it with its
   * persona. Throws VALIDATION with one field per problem (`travelerProfile.answers.<id>`).
   * The returned answers are a fresh object holding only known questions.
   */
  buildProfile(input: TravelerProfileInput): TravelerProfile {
    const fields: Record<string, string> = {};
    if (input.questionSetVersion !== this.set.version) {
      fields[`${FIELD}.questionSetVersion`] = `questionSetVersion must be ${this.set.version}, the current version`;
    }

    const answers: Record<string, string[]> = {};
    for (const [questionId, values] of Object.entries(input.answers)) {
      const field = `${FIELD}.answers.${questionId}`;
      const question = this.set.questions.find((q) => q.id === questionId);
      if (!question) {
        fields[field] = `${questionId} is not a known question`;
        continue;
      }
      const unknown = values.filter((v) => !question.options.some((o) => o.id === v));
      const max = question.type === 'single' ? 1 : question.max!;
      if (unknown.length > 0) {
        fields[field] = `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an option' : 'are not options'} of ${questionId}`;
      } else if (new Set(values).size !== values.length) {
        fields[field] = `${questionId} must not repeat an option`;
      } else if (question.type === 'single' && values.length !== 1) {
        fields[field] = `${questionId} takes exactly 1 option`;
      } else if (values.length < 1 || values.length > max) {
        fields[field] = `${questionId} takes 1 to ${max} options`;
      } else {
        answers[questionId] = [...values];
      }
    }

    if (Object.keys(fields).length > 0) throw new AppError('VALIDATION', 'Some fields are invalid', fields);
    return { questionSetVersion: this.set.version, answers, persona: computePersona(this.set, answers) };
  }
}
