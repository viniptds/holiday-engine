import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../trips/dto/is-date-only.validator.js';
import { IsOnOrAfter } from '../../trips/dto/is-on-or-after.validator.js';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';
import { Trim } from '../../trips/dto/trim.transform.js';
import { MAX_TRIP_DAYS } from '../../trips/dto/date-rules.js';
import { MAX_PARTY_SIZE, MIN_PARTY_SIZE, PARTY_TYPES } from '../app-trips.types.js';
import type { PartyType } from '../app-trips.types.js';
import { TravelerProfileInputDto } from './traveler-profile.dto.js';

// Like @IsOptional(), but only for an omitted field: `null` is still validated (and rejected).
const IfPresent = () => ValidateIf((_, value) => value !== undefined);

/**
 * `PATCH /app/v1/trips/:id` body (`UpdateTripRequest`). Omitted fields are left unchanged;
 * `null` clears notes, story, partyType, partySize and travelerProfile, and is invalid for
 * destination and the dates. Date order and the length cap are checked here when both dates
 * are sent, and against the stored trip by `AppTripsService.update`.
 */
export class UpdateAppTripDto {
  /**
   * Offline edits: the trip's `updatedAt` the client last saw. The change applies either way (last
   * write wins); the response says `overwroteNewer: true` if the trip had changed since.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  baseUpdatedAt?: string;

  @IfPresent()
  @Trim()
  @NoControlChars()
  @MaxLength(100)
  @IsNotEmpty()
  @IsString()
  destination?: string;

  @IfPresent()
  @IsDateOnly()
  startDate?: string;

  @IfPresent()
  @IsDateOnly()
  @IsOnOrAfter('startDate', { maxDays: MAX_TRIP_DAYS })
  endDate?: string;

  @IsOptional()
  @NoControlChars()
  @MaxLength(500)
  @IsString()
  notes?: string | null;

  @IsOptional()
  @NoControlChars()
  @MaxLength(1000)
  @IsString()
  story?: string | null;

  @IsOptional()
  @IsIn(PARTY_TYPES)
  partyType?: PartyType | null;

  @IsOptional()
  @Max(MAX_PARTY_SIZE)
  @Min(MIN_PARTY_SIZE)
  @IsInt()
  partySize?: number | null;

  @IsOptional()
  @ValidateNested()
  @IsObject()
  @Type(() => TravelerProfileInputDto)
  travelerProfile?: TravelerProfileInputDto | null;
}
