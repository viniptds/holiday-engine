import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

/** `POST /me/push-tokens`. Decorators run bottom-up: the type check is last. */
export class PushTokenDto {
  @Matches(/^(ExponentPushToken|ExpoPushToken)\[[^\]\s]{1,200}\]$/, { message: 'token must be an Expo push token' })
  @IsString()
  token: string;

  @IsIn(['ios', 'android', 'web'])
  platform: 'ios' | 'android' | 'web';

  @IsOptional()
  @MaxLength(200)
  @IsString()
  deviceId?: string | null;
}

/** `GET /me/notifications?before=`. */
export class NotificationsQueryDto {
  @IsOptional()
  @MaxLength(40)
  @IsString()
  before?: string;
}

/** `POST /me/notifications/read`: some ids, or all. */
export class MarkReadDto {
  @IsOptional()
  @IsUUID('4', { each: true })
  @ArrayMaxSize(200)
  @IsArray()
  @Type(() => String)
  ids?: string[];

  @IsOptional()
  @IsBoolean()
  all?: boolean;
}
