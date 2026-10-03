import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { IsDateOnly } from '../../trips/dto/is-date-only.validator.js';
import { IsOnOrAfter } from '../../trips/dto/is-on-or-after.validator.js';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';
import { Trim } from '../../trips/dto/trim.transform.js';
import { MAX_TRIP_DAYS } from '../../trips/dto/date-rules.js';
import { MAX_PARTY_SIZE, MIN_PARTY_SIZE, PARTY_TYPES } from '../app-trips.types.js';
import type { PartyType } from '../app-trips.types.js';
import { TravelerProfileInputDto } from './traveler-profile.dto.js';

/**
 * `POST /app/v1/trips` body (`CreateTripRequest`). Decorators run bottom-up, so the type
 * check is listed last: its message is the one reported for a wrong type.
 */
export class CreateAppTripDto {
  @Trim()
  @NoControlChars()
  @MaxLength(100)
  @IsNotEmpty()
  @IsString()
  destination: string;

  @IsDateOnly()
  startDate: string;

  @IsDateOnly()
  @IsOnOrAfter('startDate', { maxDays: MAX_TRIP_DAYS })
  endDate: string;

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
