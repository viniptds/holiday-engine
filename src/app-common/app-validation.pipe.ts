import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppError } from './app-error.js';

function collectFields(errors: ValidationError[], prefix = '', fields: Record<string, string> = {}) {
  for (const error of errors) {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const first = Object.values(error.constraints ?? {})[0];
    if (first && !fields[path]) fields[path] = first;
    if (error.children?.length) collectFields(error.children, path, fields);
  }
  return fields;
}

/** Validates app API bodies; unknown fields are rejected and errors become `VALIDATION` with `fields`. */
export const appValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) => new AppError('VALIDATION', 'Some fields are invalid', collectFields(errors)),
});
