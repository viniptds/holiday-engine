import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_QUESTIONS, MIN_QUESTIONS, Question, QuestionOption, QuestionSet } from './wizard.types.js';

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

/**
 * Checks a parsed question set against the contract rules and returns a clean copy (only
 * contract fields). Throws one error listing every problem found.
 */
export function parseQuestionSet(raw: unknown): QuestionSet {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error('the question set must be a JSON object');

  if (!isPositiveInt(raw.version)) problems.push('version must be a positive integer');

  const personas: Record<string, string> = {};
  if (!isObject(raw.personas) || Object.keys(raw.personas).length === 0) {
    problems.push('personas must be a non-empty object of tag -> label');
  } else {
    for (const [tag, label] of Object.entries(raw.personas)) {
      if (!isNonEmptyString(label)) problems.push(`personas.${tag} must be a non-empty label`);
      else personas[tag] = label;
    }
  }

  const questions: Question[] = [];
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

function parseQuestion(raw: unknown, at: string, personas: unknown, problems: string[]): Question | null {
  if (!isObject(raw)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const where = isNonEmptyString(raw.id) ? `question "${raw.id}"` : at;
  const before = problems.length;

  if (!isNonEmptyString(raw.id)) problems.push(`${at}.id must be a non-empty string`);
  if (!isNonEmptyString(raw.title)) problems.push(`${where}: title must be a non-empty string`);
  if (raw.type !== 'single' && raw.type !== 'multi') problems.push(`${where}: type must be "single" or "multi"`);

  const options: QuestionOption[] = [];
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    problems.push(`${where}: options must be a non-empty array`);
  } else {
    raw.options.forEach((o: unknown, j) => {
      const option = parseOption(o, `${where} options[${j}]`, personas, problems);
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
  const question: Question = { id: raw.id as string, title: raw.title as string, type: raw.type as Question['type'], options };
  if (raw.type === 'multi') question.max = raw.max as number;
  return question;
}

function parseOption(raw: unknown, at: string, personas: unknown, problems: string[]): QuestionOption | null {
  if (!isObject(raw)) {
    problems.push(`${at} must be an object`);
    return null;
  }
  const where = isNonEmptyString(raw.id) ? `${at.replace(/ options\[\d+\]$/, '')} option "${raw.id}"` : at;
  const before = problems.length;

  if (!isNonEmptyString(raw.id)) problems.push(`${at}.id must be a non-empty string`);
  if (!isNonEmptyString(raw.label)) problems.push(`${where}: label must be a non-empty string`);
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
  const option: QuestionOption = { id: raw.id as string, label: raw.label as string, icon: raw.icon as string };
  if (raw.tags !== undefined) option.tags = [...(raw.tags as string[])];
  return option;
}

/** Reads, parses and validates the question set file; errors name the file and every problem. */
export function loadQuestionSet(path: string = DEFAULT_QUESTIONS_PATH): QuestionSet {
  try {
    return parseQuestionSet(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid wizard question set (${path}): ${reason}`);
  }
}
