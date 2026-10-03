import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { IsDateOnly } from './is-date-only.validator.js';
import { IsOnOrAfter } from './is-on-or-after.validator.js';

/**
 * `trip.update` payload. Omitted fields are left unchanged; `notes: null` clears notes.
 * `endDate >= startDate` is checked here when both are sent, and against the stored
 * trip by `TripsService.update` when only one is sent.
 */
export class UpdateTripDto {
  @IsUUID()
  tripId: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  destination?: string;

  @IsOptional()
  @IsDateOnly()
  startDate?: string;

  @IsOptional()
  @IsDateOnly()
  @IsOnOrAfter('startDate')
  endDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;
}
