import { Transform } from 'class-transformer';

/** Trims string values before validation, so whitespace-only input fails `@IsNotEmpty`. Other values pass through. */
export function Trim() {
  return Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));
}
