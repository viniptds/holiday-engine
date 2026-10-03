import type { Locale } from '../app-common/locale.js';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import type { LocalizedQuestionSet } from './wizard.types.js';

/**
 * The persona key for a set of answers: the tag that appears most often across the chosen
 * options, ties going to the tag listed first in `personas`; null when no chosen option has a tag.
 * Expects answers already validated against `set`. Trips store this key, never a label.
 */
export function computePersona(set: LocalizedQuestionSet, answers: Record<string, string[]>): string | null {
  const counts = new Map<string, number>();
  for (const question of set.questions) {
    for (const optionId of answers[question.id] ?? []) {
      const option = question.options.find((o) => o.id === optionId);
      for (const tag of option?.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  for (const tag of Object.keys(set.personas)) {
    const count = counts.get(tag) ?? 0;
    if (count > 0 && count > (best === null ? 0 : counts.get(best)!)) best = tag;
  }
  return best;
}

/**
 * The persona key of a stored persona value: a key as is, or a label in any supported locale
 * (trips saved before personas were stored as keys hold the English label) mapped back to its key.
 * Null when the value is neither (e.g. a persona since removed from the question set).
 */
export function personaKey(set: LocalizedQuestionSet, stored: string): string | null {
  if (Object.hasOwn(set.personas, stored)) return stored;
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, label] of Object.entries(set.personas)) {
      if (label[locale] === stored) return key;
    }
  }
  return null;
}

/**
 * The persona label to return for a stored persona value, in `locale`. Unknown values give null
 * rather than the raw value: the contract promises a label in the request's language (or null),
 * so a stale key or a foreign-language string never reaches the app. The stored value is untouched.
 */
export function personaLabel(set: LocalizedQuestionSet, stored: string | null, locale: Locale): string | null {
  if (stored === null) return null;
  const key = personaKey(set, stored);
  return key === null ? null : set.personas[key][locale];
}
