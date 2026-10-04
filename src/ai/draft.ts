import { plainToInstance, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, validate, ValidateNested } from 'class-validator';
import { PARTY_TYPES, MAX_PARTY_SIZE, MIN_PARTY_SIZE } from '../app-trips/app-trips.types.js';
import type { PartyType } from '../app-trips/app-trips.types.js';
import { daysBetween, isDateOnlyString, MAX_TRIP_DAYS } from '../trips/dto/date-rules.js';
import { MAX_DRAFT_PLACES, MAX_DRAFT_QUESTIONS, PLACE_CATEGORIES } from './ai.types.js';
import type { DraftPlace, PlaceCategory, TripDraft } from './ai.types.js';
import type { JsonSchema } from './llm/llm-provider.js';

/** What the model returns each turn. `ready` and place verification are worked out by the engine. */
export type ModelDraft = {
  reply: string;
  destination: string | null;
  startDate: string | null;
  endDate: string | null;
  partyType: PartyType | null;
  partySize: number | null;
  story: string | null;
  places: { name: string; category: PlaceCategory; day: number | null; why: string }[];
  questions: string[];
  /** Wizard answers the traveler clearly stated; empty (or absent) otherwise. Checked by the engine. */
  travelerAnswers?: { questionId: string; optionIds: string[] }[];
};

const nullable = (schema: JsonSchema): JsonSchema => ({ anyOf: [schema, { type: 'null' }] });

/**
 * JSON Schema of `ModelDraft` for structured output. Kept to what both providers accept in strict
 * mode: every property required, `additionalProperties: false`, nullability via `anyOf`, and no
 * length or numeric constraints (those are enforced by `normalizeDraft`).
 */
export const MODEL_DRAFT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'Your message to the traveler, in the reply language.' },
    destination: nullable({ type: 'string', description: 'City or region, as the traveler would name it.' }),
    startDate: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
    endDate: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
    partyType: nullable({ type: 'string', enum: [...PARTY_TYPES] }),
    partySize: nullable({ type: 'integer', description: `${MIN_PARTY_SIZE}-${MAX_PARTY_SIZE}` }),
    story: nullable({ type: 'string', description: 'A short summary of what the traveler wants from the trip.' }),
    places: {
      type: 'array',
      description: `At most ${MAX_DRAFT_PLACES} places.`,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The real, specific name of the place.' },
          category: { type: 'string', enum: [...PLACE_CATEGORIES] },
          day: nullable({ type: 'integer', description: 'Day of the trip, starting at 1.' }),
          why: { type: 'string', description: 'One short sentence on why it fits this traveler.' },
        },
        required: ['name', 'category', 'day', 'why'],
        additionalProperties: false,
      },
    },
    questions: {
      type: 'array',
      description: `At most ${MAX_DRAFT_QUESTIONS} short questions for missing information.`,
      items: { type: 'string' },
    },
    travelerAnswers: {
      type: 'array',
      description: 'Traveler-profile answers the traveler clearly stated in their own messages; an empty array otherwise. Never guess.',
      items: {
        type: 'object',
        properties: {
          questionId: { type: 'string' },
          optionIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['questionId', 'optionIds'],
        additionalProperties: false,
      },
    },
  },
  required: ['reply', 'destination', 'startDate', 'endDate', 'partyType', 'partySize', 'story', 'places', 'questions', 'travelerAnswers'],
  additionalProperties: false,
};

// class-validator DTOs: the structural check of what the model returned. Bad structure → one retry.
class ModelPlaceDto {
  @IsString()
  name: string;

  @IsIn(PLACE_CATEGORIES)
  category: PlaceCategory;

  @IsOptional()
  @IsInt()
  day: number | null;

  @IsString()
  why: string;
}

class ModelTravelerAnswerDto {
  @IsString()
  questionId: string;

  @IsString({ each: true })
  @IsArray()
  optionIds: string[];
}

class ModelDraftDto {
  @IsString()
  reply: string;

  @IsOptional()
  @IsString()
  destination: string | null;

  @IsOptional()
  @IsString()
  startDate: string | null;

  @IsOptional()
  @IsString()
  endDate: string | null;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType: PartyType | null;

  @IsOptional()
  @IsInt()
  partySize: number | null;

  @IsOptional()
  @IsString()
  story: string | null;

  @ValidateNested({ each: true })
  @Type(() => ModelPlaceDto)
  @IsArray()
  places: ModelPlaceDto[];

  @IsString({ each: true })
  @IsArray()
  questions: string[];

  // Optional for robustness: a missing list means "nothing stated".
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ModelTravelerAnswerDto)
  @IsArray()
  travelerAnswers?: ModelTravelerAnswerDto[];
}

/** The model output, or the name of the first problem (for the retry note and logs). */
export async function parseModelDraft(json: unknown): Promise<{ draft: ModelDraft } | { problem: string }> {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { problem: 'the reply must be a JSON object' };
  const dto = plainToInstance(ModelDraftDto, json);
  const errors = await validate(dto, { whitelist: true });
  if (errors.length > 0) {
    const describe = (error: (typeof errors)[number], path: string): string => {
      const constraint = Object.values(error.constraints ?? {})[0];
      if (constraint) return `${path}${error.property}: ${constraint}`;
      const child = error.children?.[0];
      return child ? describe(child, `${path}${error.property}.`) : `${path}${error.property} is invalid`;
    };
    return { problem: describe(errors[0], '') };
  }
  return {
    draft: {
      reply: dto.reply,
      destination: dto.destination ?? null,
      startDate: dto.startDate ?? null,
      endDate: dto.endDate ?? null,
      partyType: dto.partyType ?? null,
      partySize: dto.partySize ?? null,
      story: dto.story ?? null,
      places: dto.places.map((p) => ({ name: p.name, category: p.category, day: p.day ?? null, why: p.why })),
      questions: dto.questions,
      travelerAnswers: (dto.travelerAnswers ?? []).map((a) => ({ questionId: a.questionId, optionIds: a.optionIds })),
    },
  };
}

// C0 control characters except tab, line feed and carriage return (as in the trip DTOs).
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
const ONE_LINE = /[\u0000-\u001F]+/g;

/** Trimmed, control characters removed, cut to `max` characters; empty → null. */
function cleanText(value: string | null, max: number, multiline = false): string | null {
  if (value === null) return null;
  const cleaned = value.replace(multiline ? CONTROL_CHARS : ONE_LINE, multiline ? '' : ' ').trim().slice(0, max).trim();
  return cleaned || null;
}

const validDate = (value: string | null): string | null =>
  value !== null && isDateOnlyString(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
    ? value
    : null;

/** Lower-cased, accents and punctuation removed: the key for place-lookup caching and de-duplication. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Applies the trip rules to a model draft. Lengths are cut to the column sizes, malformed dates
 * dropped, and `ready` is true only for a destination with a valid date range (end ≥ start, at
 * most 365 days). Places are de-duplicated by name and capped at 15; a `day` outside the trip
 * becomes null. Places come back unverified.
 */
export function normalizeDraft(model: ModelDraft): TripDraft {
  const destination = cleanText(model.destination, 100);
  const startDate = validDate(model.startDate);
  const endDate = validDate(model.endDate);
  const validRange =
    startDate !== null && endDate !== null && endDate >= startDate && daysBetween(startDate, endDate) <= MAX_TRIP_DAYS;
  const tripDays = validRange ? daysBetween(startDate, endDate) + 1 : MAX_TRIP_DAYS + 1;

  const seen = new Set<string>();
  const places: DraftPlace[] = [];
  for (const place of model.places) {
    const name = cleanText(place.name, 200);
    if (!name) continue;
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    places.push({
      name,
      category: place.category,
      day: place.day !== null && place.day >= 1 && place.day <= tripDays ? place.day : null,
      why: cleanText(place.why, 500) ?? '',
      verified: false,
      place: null,
    });
    if (places.length === MAX_DRAFT_PLACES) break;
  }

  const partySize =
    model.partySize !== null && model.partySize >= MIN_PARTY_SIZE && model.partySize <= MAX_PARTY_SIZE ? model.partySize : null;

  return {
    ready: destination !== null && validRange,
    destination,
    startDate,
    endDate,
    partyType: model.partyType,
    partySize,
    story: cleanText(model.story, 1000, true),
    places,
    questions: model.questions
      .map((q) => cleanText(q, 300))
      .filter((q): q is string => q !== null)
      .slice(0, MAX_DRAFT_QUESTIONS),
    // Unchecked here; the service keeps only answers valid for the question set.
    travelerAnswers: Object.fromEntries((model.travelerAnswers ?? []).map((a) => [a.questionId, a.optionIds])),
  };
}

/**
 * The model-output JSON of an earlier assistant turn, rebuilt from what was stored. Deterministic,
 * so replayed history stays byte-identical (and cacheable) from turn to turn.
 */
export function replayText(reply: string, draft: TripDraft | null): string {
  const model: ModelDraft = {
    reply,
    destination: draft?.destination ?? null,
    startDate: draft?.startDate ?? null,
    endDate: draft?.endDate ?? null,
    partyType: draft?.partyType ?? null,
    partySize: draft?.partySize ?? null,
    story: draft?.story ?? null,
    places: (draft?.places ?? []).map((p) => ({ name: p.name, category: p.category, day: p.day, why: p.why })),
    questions: draft?.questions ?? [],
    travelerAnswers: Object.entries(draft?.travelerAnswers ?? {}).map(([questionId, optionIds]) => ({ questionId, optionIds })),
  };
  return JSON.stringify(model);
}
