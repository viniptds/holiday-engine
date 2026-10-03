import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';
import { Trim } from '../../trips/dto/trim.transform.js';
import { MAX_TRIP_DAYS } from '../../trips/dto/date-rules.js';
import { MAX_TRIP_PLACES, PLACE_CATEGORIES } from '../ai.types.js';
import type { PlaceCategory } from '../ai.types.js';

/** `HH:MM`, 24-hour. */
export const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAY = MAX_TRIP_DAYS + 1;

// Like @IsOptional(), but only for an omitted field: `null` is still validated (and rejected).
const IfPresent = () => ValidateIf((_, value) => value !== undefined);

/** `GET /trips/:id/places/search?q=&category=`. Decorators run bottom-up: the type check is last. */
export class SearchPlacesQueryDto {
  @Trim()
  @NoControlChars()
  @MaxLength(100)
  @IsNotEmpty()
  @IsString()
  q: string;

  @IsOptional()
  @IsIn(PLACE_CATEGORIES)
  category?: PlaceCategory;
}

/** `POST /trips/:id/places`. `day` is checked against the trip's length by the service. */
export class AddPlaceDto {
  @Trim()
  @MaxLength(300)
  @IsNotEmpty()
  @IsString()
  googlePlaceId: string;

  @IsOptional()
  @IsIn(PLACE_CATEGORIES)
  category?: PlaceCategory;

  @IsOptional()
  @Max(MAX_DAY)
  @Min(1)
  @IsInt()
  day?: number | null;

  @IsOptional()
  @Matches(START_TIME, { message: 'startTime must be HH:MM (24-hour)' })
  @IsString()
  startTime?: string | null;

  @IsOptional()
  @NoControlChars()
  @MaxLength(500)
  @IsString()
  notes?: string | null;
}

/** `PATCH /trips/:id/places/:placeId`: `null` clears startTime and notes; category can't be null. */
export class PatchPlaceDto {
  @IfPresent()
  @IsIn(PLACE_CATEGORIES)
  category?: PlaceCategory;

  @IsOptional()
  @Matches(START_TIME, { message: 'startTime must be HH:MM (24-hour)' })
  @IsString()
  startTime?: string | null;

  @IsOptional()
  @NoControlChars()
  @MaxLength(500)
  @IsString()
  notes?: string | null;
}

/** One group of `PUT /trips/:id/itinerary`: a day (or null for Unplanned) and its places in order. */
export class ItineraryDayDto {
  @ValidateIf((_, value) => value !== null)
  @Max(MAX_DAY)
  @Min(1)
  @IsInt()
  day: number | null;

  @IsUUID('4', { each: true })
  @ArrayMaxSize(MAX_TRIP_PLACES)
  @IsArray()
  placeIds: string[];
}

/** `PUT /trips/:id/itinerary`: the whole ordering, at the version the client last saw. */
export class PutItineraryDto {
  @Min(0)
  @IsInt()
  itineraryVersion: number;

  @ValidateNested({ each: true })
  @Type(() => ItineraryDayDto)
  @ArrayMaxSize(MAX_DAY + 1)
  @IsArray()
  days: ItineraryDayDto[];
}
