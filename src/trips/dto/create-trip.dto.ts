import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsDateOnly } from './is-date-only.validator.js';
import { IsOnOrAfter } from './is-on-or-after.validator.js';

/** `trip.create` payload. */
export class CreateTripDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destination: string;

  @IsDateOnly()
  startDate: string;

  @IsDateOnly()
  @IsOnOrAfter('startDate')
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
