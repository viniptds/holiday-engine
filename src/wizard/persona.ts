import { QuestionSet } from './wizard.types.js';

/**
 * The persona label for a set of answers: the tag that appears most often across the chosen
 * options, ties going to the tag listed first in `personas`; null when no chosen option has a tag.
 * Expects answers already validated against `set`.
 */
export function computePersona(set: QuestionSet, answers: Record<string, string[]>): string | null {
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
  return best === null ? null : set.personas[best];
}
