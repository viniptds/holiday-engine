import { Matches, ValidationOptions } from 'class-validator';

// C0 control characters except tab, line feed and carriage return. Postgres rejects NUL in text.
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F]*$/;

/** Rejects strings containing control characters (other than `\t`, `\n`, `\r`). */
export function NoControlChars(options?: ValidationOptions) {
  return Matches(NO_CONTROL_CHARS, { message: '$property must not contain control characters', ...options });
}
