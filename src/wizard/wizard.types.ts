/** Wizard question set types (`docs/app-api-contract.md`). */
import type { Locale } from '../app-common/locale.js';

export type QuestionType = 'single' | 'multi';

/** Contract shapes: what `GET /wizard/questions` returns, with every text in the request's language. */
export type QuestionOption = { id: string; label: string; icon: string; tags?: string[] };

export type Question = { id: string; title: string; type: QuestionType; max?: number; options: QuestionOption[] };

export type QuestionSet = { version: number; questions: Question[]; personas: Record<string, string> };

/** A user-facing text in every supported locale (all required, non-empty). */
export type LocalizedText = Record<Locale, string>;

/** The loaded `questions.json`: the contract shapes with every user-facing text localized. */
export type LocalizedQuestionOption = Omit<QuestionOption, 'label'> & { label: LocalizedText };

export type LocalizedQuestion = Omit<Question, 'title' | 'options'> & {
  title: LocalizedText;
  options: LocalizedQuestionOption[];
};

export type LocalizedQuestionSet = {
  version: number;
  questions: LocalizedQuestion[];
  /** Persona key (the tag) -> label in every locale. Key order breaks persona ties. */
  personas: Record<string, LocalizedText>;
};

/** Injection token of the loaded, validated `LocalizedQuestionSet`. */
export const QUESTION_SET = Symbol('QUESTION_SET');

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 5;
