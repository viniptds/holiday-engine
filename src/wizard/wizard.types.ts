/** Wizard question set types (`docs/app-api-contract.md`). */

export type QuestionType = 'single' | 'multi';

export type QuestionOption = { id: string; label: string; icon: string; tags?: string[] };

export type Question = { id: string; title: string; type: QuestionType; max?: number; options: QuestionOption[] };

export type QuestionSet = { version: number; questions: Question[]; personas: Record<string, string> };

/** Injection token of the loaded, validated `QuestionSet`. */
export const QUESTION_SET = Symbol('QUESTION_SET');

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
