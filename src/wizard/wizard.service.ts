import { Inject, Injectable } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { TravelerProfile } from '../app-trips/app-trips.types.js';
import type { Locale } from '../app-common/locale.js';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import { QUESTION_SET } from './wizard.types.js';
import type { LocalizedQuestionSet, QuestionSet } from './wizard.types.js';
import { computePersona, personaKey, personaLabel } from './persona.js';
import { resolveQuestionSet } from './localize.js';

/** `travelerProfile` as clients send it: the persona is always computed here. */
export type TravelerProfileInput = { questionSetVersion: number; answers: Record<string, string[]> };

const FIELD = 'travelerProfile';

@Injectable()
export class WizardService {
  /** The contract question set in each locale, resolved once (the set never changes at runtime). */
  private readonly resolved: Record<Locale, QuestionSet>;

  constructor(@Inject(QUESTION_SET) private readonly set: LocalizedQuestionSet) {
    this.resolved = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, resolveQuestionSet(set, l)])) as Record<
      Locale,
      QuestionSet
    >;
  }

  /** The question set with every title and label in `locale`. */
  getQuestionSet(locale: Locale): QuestionSet {
    return this.resolved[locale];
  }

  /**
   * Validates a client profile against the current question set and returns it as stored, with
   * its persona KEY (see `presentProfile` for responses). Throws VALIDATION with one field per
   * problem (`travelerProfile.answers.<id>`). The returned answers are a fresh object holding
   * only known questions.
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

  /**
   * A stored profile as the API returns it: the persona as its label in `locale`. Stored
   * personas are keys; older rows hold the English label, which maps back to its key. An
   * unknown persona value is returned as null (see `personaLabel`). Returns a fresh object.
   */
  presentProfile(stored: TravelerProfile | null, locale: Locale): TravelerProfile | null {
    if (!stored) return null;
    return {
      questionSetVersion: stored.questionSetVersion,
      answers: stored.answers,
      persona: personaLabel(this.set, stored.persona ?? null, locale),
    };
  }

  /**
   * A stored profile with its persona normalized to a key, for writing back: a legacy label
   * becomes its key; an unknown value is kept as is (never lose stored data on write).
   */
  normalizeProfile(stored: TravelerProfile | null): TravelerProfile | null {
    if (!stored?.persona) return stored;
    const key = personaKey(this.set, stored.persona);
    return key === null || key === stored.persona ? stored : { ...stored, persona: key };
  }
}
