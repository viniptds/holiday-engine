import { SUPPORTED_LOCALES } from '../../app-common/locale.js';
import type { Locale } from '../../app-common/locale.js';
import { REPLY_LANGUAGE_PREFIX } from '../prompt.js';
import type { ModelDraft } from '../draft.js';
import type { DraftTurnInput, DraftTurnResult, LlmProvider } from './llm-provider.js';
import { CHECKLIST_SUGGESTIONS_SCHEMA } from '../checklist-schema.js';

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

type MockItem = { title: string; notes: string; priority: 'high' | 'medium' | 'low'; category: string };
const item = (title: string, priority: MockItem['priority'], category: string, notes = ''): MockItem => ({ title, notes, priority, category });
/** Deterministic checklist suggestions per language (10 items). */
const MOCK_CHECKLIST: Record<Locale, MockItem[]> = {
  en: [
    item('Check passport validity', 'high', 'documents', 'Many countries ask for 6 months of validity.'),
    item('Buy travel insurance', 'high', 'health'),
    item('Book airport transfer', 'medium', 'bookings'),
    item('Tell your bank about the trip', 'medium', 'money'),
    item('Get some local currency', 'low', 'money'),
    item('Pack a power adapter', 'medium', 'tech'),
    item('Download offline maps', 'low', 'tech'),
    item('Pack comfortable walking shoes', 'medium', 'packing'),
    item('Refill prescriptions', 'high', 'health'),
    item('Share the itinerary with family', 'low', 'other'),
  ],
  'pt-BR': [
    item('Verificar a validade do passaporte', 'high', 'documents', 'Muitos países pedem 6 meses de validade.'),
    item('Contratar seguro-viagem', 'high', 'health'),
    item('Reservar o transfer do aeroporto', 'medium', 'bookings'),
    item('Avisar o banco sobre a viagem', 'medium', 'money'),
    item('Trocar um pouco de moeda local', 'low', 'money'),
    item('Levar um adaptador de tomada', 'medium', 'tech'),
    item('Baixar mapas offline', 'low', 'tech'),
    item('Levar sapatos confortáveis', 'medium', 'packing'),
    item('Renovar as receitas médicas', 'high', 'health'),
    item('Compartilhar o roteiro com a família', 'low', 'other'),
  ],
  es: [
    item('Revisar la vigencia del pasaporte', 'high', 'documents', 'Muchos países piden 6 meses de vigencia.'),
    item('Contratar un seguro de viaje', 'high', 'health'),
    item('Reservar el traslado del aeropuerto', 'medium', 'bookings'),
    item('Avisar al banco del viaje', 'medium', 'money'),
    item('Cambiar algo de moneda local', 'low', 'money'),
    item('Llevar un adaptador de enchufe', 'medium', 'tech'),
    item('Descargar mapas sin conexión', 'low', 'tech'),
    item('Llevar zapatos cómodos', 'medium', 'packing'),
    item('Renovar las recetas médicas', 'high', 'health'),
    item('Compartir el itinerario con la familia', 'low', 'other'),
  ],
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
    if (input.schema === CHECKLIST_SUGGESTIONS_SCHEMA) return { json: { items: MOCK_CHECKLIST[locale] }, model: 'mock', inputTokens: 10, outputTokens: 10 };
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
