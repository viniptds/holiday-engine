import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, ValidateIf } from 'class-validator';
import { IsDateOnly } from './is-date-only.validator.js';
import { Trim } from './trim.transform.js';
import { IsOnOrAfter } from './is-on-or-after.validator.js';
import { MAX_TRIP_DAYS } from './date-rules.js';

// Like @IsOptional(), but only for an omitted field: `null` is still validated (and rejected).
const IfPresent = () => ValidateIf((_, value) => value !== undefined);

/**
 * `trip.update` payload. Omitted fields are left unchanged; `notes: null` clears notes,
 * `null` for any other field is invalid. Date order and the trip length cap are checked
 * here when both dates are sent, and against the stored trip by `TripsService.update`.
 */
export class UpdateTripDto {
  @IsUUID('4')
  tripId: string;

  @IfPresent()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destination?: string;

  @IfPresent()
  @IsDateOnly()
  startDate?: string;

  @IfPresent()
  @IsDateOnly()
  @IsOnOrAfter('startDate', { maxDays: MAX_TRIP_DAYS })
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
