import type { JsonSchema } from './llm/llm-provider.js';

/**
 * Structured output for checklist suggestions (docs/app-notifications-checklist-calendar-spec.md).
 * Strict-mode friendly: every property required, no extra properties. Counts are checked in code.
 */
export const CHECKLIST_SUGGESTIONS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short action, at most 120 characters, in the reply language.' },
          notes: { type: 'string', description: 'One helpful sentence, at most 300 characters, or an empty string.' },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
          category: { type: 'string', enum: ['documents', 'health', 'money', 'packing', 'tech', 'bookings', 'other'] },
        },
        required: ['title', 'notes', 'priority', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};
