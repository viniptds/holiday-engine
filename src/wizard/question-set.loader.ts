import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { MAX_QUESTIONS, MIN_QUESTIONS } from './wizard.types.js';
import type { LocalizedQuestion, LocalizedQuestionOption, LocalizedQuestionSet, LocalizedText } from './wizard.types.js';

/**
 * The bundled question set. Resolved next to this module, so it works from `src/` (ts-jest,
 * `nest start`) and from `dist/` (nest-cli.json copies the asset there).
 */
export const DEFAULT_QUESTIONS_PATH = fileURLToPath(new URL('./questions.json', import.meta.url));

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isPositiveInt = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;

function duplicates(values: string[]): string[] {
  return [...new Set(values.filter((value, i) => values.indexOf(value) !== i))];
}

const LOCALE_LIST = SUPPORTED_LOCALES.map((l) => `"${l}"`).join(', ');

/**
 * A user-facing text: an object with a non-empty string for every supported locale. Each problem
 * names the text by its path (`questions[1].options[2].label is missing "es"`).
 */
function parseLocalized(raw: unknown, at: string, problems: string[]): LocalizedText | null {
  if (!isObject(raw)) {
    problems.push(`${at} must be an object with a text for each locale (${LOCALE_LIST})`);
    return null;
  }
  const before = problems.length;
  for (const key of Object.keys(raw)) {
    if (!(SUPPORTED_LOCALES as readonly string[]).includes(key)) problems.push(`${at} has unsupported locale "${key}"`);
  }
  for (const locale of SUPPORTED_LOCALES) {
    if (!isNonEmptyString(raw[locale])) problems.push(`${at} is missing "${locale}"`);
  }
  if (problems.length > before) return null;
  return Object.fromEntries(SUPPORTED_LOCALES.map((locale) => [locale, raw[locale] as string])) as Record<Locale, string>;
}

/**
 * Checks a parsed question set against the contract rules and returns a clean copy (only
 * contract fields). Every title, option label and persona label must have a text for each
 * supported locale. Throws one error listing every problem found.
 */
export function parseQuestionSet(raw: unknown): LocalizedQuestionSet {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error('the question set must be a JSON object');

  if (!isPositiveInt(raw.version)) problems.push('version must be a positive integer');

  const personas: Record<string, LocalizedText> = {};
  if (!isObject(raw.personas) || Object.keys(raw.personas).length === 0) {
    problems.push('personas must be a non-empty object of tag -> localized label');
  } else {
    for (const [tag, label] of Object.entries(raw.personas)) {
      const localized = parseLocalized(label, `personas.${tag}`, problems);
      if (localized) personas[tag] = localized;
    }
  }

  const questions: LocalizedQuestion[] = [];
  if (!Array.isArray(raw.questions)) {
    problems.push('questions must be an array');
  } else {
    if (raw.questions.length < MIN_QUESTIONS || raw.questions.length > MAX_QUESTIONS) {
      problems.push(`questions must have ${MIN_QUESTIONS}-${MAX_QUESTIONS} entries (has ${raw.questions.length})`);
    }
    raw.questions.forEach((q: unknown, i) => {
      const question = parseQuestion(q, `questions[${i}]`, raw.personas, problems);
      if (question) questions.push(question);
    });
    for (const id of duplicates(questions.map((q) => q.id))) problems.push(`question id "${id}" is used more than once`);
  }

  if (problems.length > 0) throw new Error(problems.join('; '));
  return { version: raw.version as number, questions, personas };
}

function parseQuestion(raw: unknown, at: string, personas: unknown, problems: string[]): LocalizedQuestion | null {
  if (!isObject(raw)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const where = isNonEmptyString(raw.id) ? `question "${raw.id}"` : at;
  const before = problems.length;

  if (!isNonEmptyString(raw.id)) problems.push(`${at}.id must be a non-empty string`);
  const title = parseLocalized(raw.title, `${at}.title`, problems);
  if (raw.type !== 'single' && raw.type !== 'multi') problems.push(`${where}: type must be "single" or "multi"`);

  const options: LocalizedQuestionOption[] = [];
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    problems.push(`${where}: options must be a non-empty array`);
  } else {
    raw.options.forEach((o: unknown, j) => {
      const option = parseOption(o, { path: `${at}.options[${j}]`, question: where, index: j }, personas, problems);
      if (option) options.push(option);
    });
    for (const id of duplicates(options.map((o) => o.id))) {
      problems.push(`${where}: option id "${id}" is used more than once`);
    }
  }

  if (raw.type === 'multi') {
    if (!isPositiveInt(raw.max) || raw.max > options.length) {
      problems.push(`${where}: a multi question needs max between 1 and its number of options (${options.length})`);
    }
  } else if (raw.max !== undefined) {
    problems.push(`${where}: max only applies to multi questions`);
  }

  if (problems.length > before) return null;
  const question: LocalizedQuestion = { id: raw.id as string, title: title!, type: raw.type as LocalizedQuestion['type'], options };
  if (raw.type === 'multi') question.max = raw.max as number;
  return question;
}

/**
 * `at.path` is the option's path (`questions[1].options[2]`, used for its localized label),
 * `at.question` how its question is named in the other messages.
 */
function parseOption(
  raw: unknown,
  at: { path: string; question: string; index: number },
  personas: unknown,
  problems: string[],
): LocalizedQuestionOption | null {
  const { question } = at;
  const indexed = `${question} options[${at.index}]`;
  if (!isObject(raw)) {
    problems.push(`${indexed} must be an object`);
    return null;
  }
  const where = isNonEmptyString(raw.id) ? `${question} option "${raw.id}"` : indexed;
  const before = problems.length;

  if (!isNonEmptyString(raw.id)) problems.push(`${indexed}.id must be a non-empty string`);
  const label = parseLocalized(raw.label, `${at.path}.label`, problems);
  if (!isNonEmptyString(raw.icon)) problems.push(`${where}: icon must be a non-empty string`);
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || !raw.tags.every((t) => typeof t === 'string')) {
      problems.push(`${where}: tags must be an array of strings`);
    } else {
      for (const tag of raw.tags as string[]) {
        if (!isObject(personas) || !Object.hasOwn(personas, tag)) {
          problems.push(`${where}: tag "${tag}" is not a key of personas`);
        }
      }
      for (const tag of duplicates(raw.tags as string[])) problems.push(`${where}: tag "${tag}" is listed twice`);
    }
  }

  if (problems.length > before) return null;
  const option: LocalizedQuestionOption = { id: raw.id as string, label: label!, icon: raw.icon as string };
  if (raw.tags !== undefined) option.tags = [...(raw.tags as string[])];
  return option;
}

/** Reads, parses and validates the question set file; errors name the file and every problem. */
export function loadQuestionSet(path: string = DEFAULT_QUESTIONS_PATH): LocalizedQuestionSet {
  try {
    return parseQuestionSet(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid wizard question set (${path}): ${reason}`);
  }
}
