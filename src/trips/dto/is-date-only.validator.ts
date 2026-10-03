import { applyDecorators } from '@nestjs/common';
import { IsISO8601, Matches, ValidationOptions } from 'class-validator';

/** A real calendar date in `YYYY-MM-DD` form (rejects e.g. `2026-02-30`). */
export function IsDateOnly(options?: ValidationOptions) {
  return applyDecorators(
    Matches(/^\d{4}-\d{2}-\d{2}$/, { message: '$property must be a YYYY-MM-DD date', ...options }),
    IsISO8601({ strict: true }, { message: '$property must be a valid date', ...options }),
  );
}
