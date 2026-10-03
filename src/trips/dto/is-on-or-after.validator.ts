import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';
import { daysBetween, isDateOnlyString } from './date-rules.js';

type DateOrderOptions = { maxDays?: number };

/**
 * The decorated `YYYY-MM-DD` value must be on or after the sibling `property`, and at most
 * `maxDays` after it when given. Skipped unless both values are `YYYY-MM-DD` strings
 * (the date-format decorators report malformed values).
 */
export function IsOnOrAfter(property: string, { maxDays }: DateOrderOptions = {}, options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isOnOrAfter',
      target: object.constructor,
      propertyName,
      constraints: [property, maxDays],
      options: {
        message: (args: ValidationArguments) => {
          const other = (args.object as Record<string, unknown>)[property] as string;
          return (args.value as string) < other
            ? `${propertyName} must be on or after ${property}`
            : `${propertyName} must be at most ${maxDays} days after ${property}`;
        },
        ...options,
      },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const other = (args.object as Record<string, unknown>)[property];
          if (!isDateOnlyString(value) || !isDateOnlyString(other)) return true;
          // Same-format ISO dates compare correctly as strings.
          if (value < other) return false;
          return maxDays === undefined || daysBetween(other, value) <= maxDays;
        },
      },
    });
  };
}
