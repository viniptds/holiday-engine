import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsString, IsUUID, MaxLength, ValidateIf, ValidateNested } from 'class-validator';
import { ACHIEVEMENT_EVENT_TYPES } from './achievements.types.js';

/** `POST /achievements/events`. */
export class AchievementEventDto {
  @IsIn(ACHIEVEMENT_EVENT_TYPES)
  type: 'collage_shared';

  @IsUUID('4')
  tripId: string;
}

export class AchievementRefDto {
  @MaxLength(64)
  @IsNotEmpty()
  @IsString()
  key: string;

  @ValidateIf((_o, v) => v !== null)
  @IsUUID('4')
  tripId: string | null;
}

/** `POST /achievements/seen`. */
export class AchievementsSeenDto {
  @ValidateNested({ each: true })
  @Type(() => AchievementRefDto)
  @ArrayMaxSize(200)
  @IsArray()
  keys: AchievementRefDto[];
}
