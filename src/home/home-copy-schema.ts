import type { JsonSchema } from '../ai/llm/llm-provider.js';
import { HOME_COPY_VARIANTS } from './home.types.js';

/**
 * Structured output of the nightly copy refresh: fresh headline/subline pairs. The mock LLM
 * recognizes this object by identity (like the checklist schema), so keep the single instance.
 */
export const HOME_COPY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['variants'],
  properties: {
    variants: {
      type: 'array',
      minItems: HOME_COPY_VARIANTS,
      maxItems: HOME_COPY_VARIANTS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['headline', 'subline'],
        properties: { headline: { type: 'string' }, subline: { type: 'string' } },
      },
    },
  },
};

/** The line the refresh prompt names the destination on; the mock reads it back. */
export const HOME_COPY_DESTINATION_PREFIX = 'Destination: ';
