import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { IsDateOnly } from './is-date-only.validator.js';
import { Trim } from './trim.transform.js';
import { NoControlChars } from './no-control-chars.validator.js';
import { IsOnOrAfter } from './is-on-or-after.validator.js';
import { MAX_TRIP_DAYS } from './date-rules.js';

/** `trip.create` payload. */
export class CreateTripDto {
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoControlChars()
  destination: string;

  @IsDateOnly()
  startDate: string;

  @IsDateOnly()
  @IsOnOrAfter('startDate', { maxDays: MAX_TRIP_DAYS })
  endDate: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  @NoControlChars()
  notes?: string | null;
}
