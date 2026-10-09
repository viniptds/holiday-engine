import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsNumber, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { MAX_MOMENT_BYTES, MOMENT_CONTENT_TYPES, MOMENT_SOURCES } from './moments.types.js';

/** `POST /moments`. Decorators run bottom-up: the type check is last. */
export class CreateMomentDto {
  // null or omitted: unassigned.
  @IsOptional()
  @IsUUID('4')
  tripId?: string | null;

  @IsOptional()
  @IsIn(MOMENT_SOURCES)
  source?: 'camera' | 'upload';

  /** Uploads only (1…tripDays or null); camera moments must not send it. Checked against the trip by the service. */
  @IsOptional()
  @Max(366)
  @Min(1)
  @IsInt()
  day?: number | null;

  @IsIn(MOMENT_CONTENT_TYPES)
  contentType: 'image/jpeg';

  @Max(MAX_MOMENT_BYTES)
  @Min(1)
  @IsInt()
  byteSize: number;

  @Max(20_000)
  @Min(1)
  @IsInt()
  width: number;

  @Max(20_000)
  @Min(1)
  @IsInt()
  height: number;

  @IsISO8601({ strict: true })
  takenAt: string;

  @IsOptional()
  @Max(90)
  @Min(-90)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  lat?: number | null;

  @IsOptional()
  @Max(180)
  @Min(-180)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  lng?: number | null;
}

/**
 * `PATCH /moments/:id`: `tripId` moves it (null unassigns; uploader only), `day` changes an
 * upload's day (1…tripDays or null; uploader or trip owner). At least one of them.
 */
export class PatchMomentDto {
  @ValidateIf((o: PatchMomentDto, v) => v !== null && (v !== undefined || o.day === undefined))
  @IsUUID('4')
  tripId?: string | null;

  @ValidateIf((_o, v) => v !== null && v !== undefined)
  @Max(366)
  @Min(1)
  @IsInt()
  day?: number | null;
}

/** `GET /moments?unassigned=true`. */
export class ListMomentsQueryDto {
  @IsIn(['true'])
  @Type(() => String)
  unassigned: 'true';
}
