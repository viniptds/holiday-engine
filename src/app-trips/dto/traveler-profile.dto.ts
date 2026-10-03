import { IsInt, IsObject, Min, registerDecorator, ValidationOptions } from 'class-validator';

const isAnswerMap = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(
    (options) => Array.isArray(options) && options.every((option) => typeof option === 'string' && option.length > 0),
  );

/** A plain object mapping question ids to arrays of option ids. */
function IsAnswerMap(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isAnswerMap',
      target: object.constructor,
      propertyName,
      options: { message: '$property must map question ids to arrays of option ids', ...options },
      validator: { validate: isAnswerMap },
    });
  };
}

/**
 * `travelerProfile` as clients send it (no persona: the engine computes it).
 * Only the shape is checked here; `WizardService.buildProfile` checks it against the question set.
 */
export class TravelerProfileInputDto {
  @Min(1)
  @IsInt()
  questionSetVersion: number;

  @IsAnswerMap()
  @IsObject()
  answers: Record<string, string[]>;
}
