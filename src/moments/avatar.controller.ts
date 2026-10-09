import { Body, Controller, Delete, HttpCode, HttpStatus, Post, UseFilters, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsUUID, Max, Min } from 'class-validator';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { UserDto } from '../users/user.dto.js';
import { AvatarService, MAX_AVATAR_BYTES } from './avatar.service.js';
import type { PresignedUpload, StorageRequestContext } from './storage/object-storage.js';
import { StorageContext } from './request-base-url.js';

/** `POST /me/avatar`. Decorators run bottom-up: the type check is last. */
export class AvatarUploadDto {
  @IsIn(['image/jpeg'])
  contentType: 'image/jpeg';

  @Max(MAX_AVATAR_BYTES)
  @Min(1)
  @IsInt()
  byteSize: number;

  @Max(10_000)
  @Min(1)
  @IsInt()
  width: number;

  @Max(10_000)
  @Min(1)
  @IsInt()
  height: number;
}

export class AvatarCompleteDto {
  @IsUUID('4')
  uploadId: string;
}

/** The profile picture (docs/app-profile-offline-spec.md §1). */
@Controller(`${APP_PREFIX}/me/avatar`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class AvatarController {
  constructor(private readonly avatars: AvatarService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  start(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: AvatarUploadDto, @StorageContext() context: StorageRequestContext): Promise<{ uploadId: string; upload: PresignedUpload }> {
    return this.avatars.start(user, body, context);
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: AvatarCompleteDto): Promise<UserDto> {
    return this.avatars.complete(user, body.uploadId);
  }

  @Post('google')
  @HttpCode(HttpStatus.OK)
  useGoogle(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return this.avatars.useGoogle(user);
  }

  @Delete()
  remove(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return this.avatars.remove(user);
  }
}
