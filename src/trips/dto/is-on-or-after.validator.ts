import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * The decorated `YYYY-MM-DD` value must be on or after the sibling `property`.
 * Skipped when either value is missing (other decorators handle presence/format).
 */
export function IsOnOrAfter(property: string, options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isOnOrAfter',
      target: object.constructor,
      propertyName,
      constraints: [property],
      options: { message: `${propertyName} must be on or after ${property}`, ...options },
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const other = (args.object as Record<string, unknown>)[args.constraints[0] as string];
          if (typeof value !== 'string' || typeof other !== 'string') return true;
          // Same-format ISO dates compare correctly as strings.
          return value >= other;
        },
      },
    });
  };
}
