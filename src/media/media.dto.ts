import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_CITY_PHOTOS, MAX_PLACE_PHOTOS, PHOTO_SIZES } from './media.types.js';
import type { PhotoSize } from './media.types.js';

/** `GET /media/place/:id?count=&size=`. Decorators run bottom-up: the type check is last. */
export class PlacePhotosQueryDto {
  @IsOptional()
  @Max(MAX_PLACE_PHOTOS)
  @Min(1)
  @IsInt()
  @Type(() => Number)
  count?: number;

  @IsOptional()
  @IsIn(PHOTO_SIZES)
  size?: PhotoSize;
}

/** `GET /media/city?q=&count=&size=`. */
export class CityPhotosQueryDto {
  @MaxLength(100)
  @IsNotEmpty()
  @IsString()
  q: string;

  @IsOptional()
  @Max(MAX_CITY_PHOTOS)
  @Min(1)
  @IsInt()
  @Type(() => Number)
  count?: number;

  @IsOptional()
  @IsIn(PHOTO_SIZES)
  size?: PhotoSize;
}
