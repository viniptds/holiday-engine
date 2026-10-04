import { SUPPORTED_LOCALES } from '../../app-common/locale.js';
import type { Locale } from '../../app-common/locale.js';
import { REPLY_LANGUAGE_PREFIX } from '../prompt.js';
import type { ModelDraft } from '../draft.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from './llm-provider.js';

const TEXT: Record<Locale, { where: string; when: string; ready: (d: string) => string; more: string }> = {
  en: {
    where: 'Where would you like to go?',
    when: 'What are your travel dates?',
    ready: (d) => `Here is a first plan for ${d}. Confirm it when you're happy.`,
    more: 'Tell me a bit more and I will shape the plan.',
  },
  'pt-BR': {
    where: 'Para onde você gostaria de ir?',
    when: 'Quais são as datas da viagem?',
    ready: (d) => `Aqui está um primeiro plano para ${d}. Confirme quando estiver tudo certo.`,
    more: 'Me conte um pouco mais e eu monto o plano.',
  },
  es: {
    where: '¿A dónde te gustaría ir?',
    when: '¿Cuáles son las fechas del viaje?',
    ready: (d) => `Aquí tienes un primer plan para ${d}. Confírmalo cuando quieras.`,
    more: 'Cuéntame un poco más y armo el plan.',
  },
};

const DESTINATION = /\b(?:to|in|visit|visiting|para|em|a|en)\s+(\p{Lu}[\p{L}'-]+(?:\s\p{Lu}[\p{L}'-]+)*)/u;
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
// A clearly stated pace (the only traveler answer the mock fills, so persona flows can run offline).
const RELAXED = /\b(relaxed|slow|calm|tranquil[oa]?|relajad[oa]|devagar|sem pressa)\b/i;

const PEOPLE = /\b(\d{1,2})\s*(?:people|persons|travell?ers|adults|pessoas|personas)\b/i;

function localeOf(system: string): Locale {
  const line = system.split('\n').find((l) => l.startsWith(REPLY_LANGUAGE_PREFIX)) ?? '';
  const tag = line.slice(REPLY_LANGUAGE_PREFIX.length).split(' ')[0];
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag) ? (tag as Locale) : 'en';
}

/** The draft of the latest assistant turn in the history (the replayed JSON), if any. */
function previousDraft(input: DraftTurnInput): ModelDraft | null {
  for (let i = input.history.length - 1; i >= 0; i -= 1) {
    const entry = input.history[i];
    if (entry.role !== 'assistant') continue;
    try {
      return JSON.parse(entry.text) as ModelDraft;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Deterministic offline stand-in for tests and dev. It reads simple cues from the latest user
 * message (a capitalized destination after "to"/"in", `YYYY-MM-DD` dates, "3 people"), keeps what
 * earlier turns found, and proposes three places once the destination is known.
 */
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock' as const;

  async draftTurn(input: DraftTurnInput): Promise<DraftTurnResult> {
    const locale = localeOf(input.system);
    const text = TEXT[locale];
    const last = [...input.history].reverse().find((e) => e.role === 'user')?.text ?? '';
    const before = previousDraft(input);

    const destination = DESTINATION.exec(last)?.[1] ?? before?.destination ?? null;
    const dates = last.match(DATE) ?? [];
    const startDate = dates[0] ?? before?.startDate ?? null;
    const endDate = dates[1] ?? before?.endDate ?? null;
    const people = PEOPLE.exec(last);
    const partySize = people ? Number(people[1]) : (before?.partySize ?? null);

    const questions = [!destination && text.where, (!startDate || !endDate) && text.when].filter(
      (q): q is string => typeof q === 'string',
    );
    const places: ModelDraft['places'] = destination
      ? [
          { name: `${destination} Old Town`, category: 'sight', day: 1, why: 'The historic centre, best on foot.' },
          { name: `${destination} Central Market`, category: 'food', day: 1, why: 'Local food in one place.' },
          { name: `${destination} City Park`, category: 'nature', day: 2, why: 'A calm green break.' },
        ]
      : [];

    const relaxed = input.history.some((e) => e.role === 'user' && RELAXED.test(e.text));
    const draft: ModelDraft = {
      reply: destination && startDate && endDate ? text.ready(destination) : text.more,
      destination,
      startDate,
      endDate,
      partyType: partySize === 1 ? 'solo' : (before?.partyType ?? null),
      partySize,
      story: before?.story ?? null,
      places,
      questions,
      travelerAnswers: relaxed ? [{ questionId: 'pace', optionIds: ['slow'] }] : [],
    };
    const inputTokens = input.system.length + input.history.reduce((n, e) => n + e.text.length, 0);
    return { json: draft, model: 'mock', inputTokens: Math.ceil(inputTokens / 4), outputTokens: 100 };
  }
}
