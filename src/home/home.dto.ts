import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';

/** `GET /home/weather?lat=&lng=` or `?city=`. Decorators run bottom-up: the type check is last. */
export class WeatherQueryDto {
  @ValidateIf((o: WeatherQueryDto) => o.city === undefined)
  @Max(90)
  @Min(-90)
  @IsNumber()
  @Type(() => Number)
  lat?: number;

  @ValidateIf((o: WeatherQueryDto) => o.city === undefined)
  @Max(180)
  @Min(-180)
  @IsNumber()
  @Type(() => Number)
  lng?: number;

  @IsOptional()
  @Matches(/^[a-z0-9-]{1,64}$/)
  @IsString()
  city?: string;
}

/** `GET /home/banners?lat=&lng=` (both, or neither). */
export class BannersQueryDto {
  @ValidateIf((o: BannersQueryDto) => o.lng !== undefined)
  @Max(90)
  @Min(-90)
  @IsNumber()
  @Type(() => Number)
  lat?: number;

  @ValidateIf((o: BannersQueryDto) => o.lat !== undefined)
  @Max(180)
  @Min(-180)
  @IsNumber()
  @Type(() => Number)
  lng?: number;
}
