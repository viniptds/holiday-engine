import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Patch, UseFilters, UseGuards, UsePipes } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { UsersService } from '../users/users.service.js';
import { toUserDto } from '../users/user.dto.js';
import type { UserDto } from '../users/user.dto.js';
import { UpdateProfileDto } from '../users/dto/update-profile.dto.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import { RequestTimezone } from '../app-common/timezone.js';
import { MeExtensions } from '../users/me-extensions.js';

@Controller(`${APP_PREFIX}/me`)
@UseFilters(AppExceptionFilter)
@UsePipes(appValidationPipe)
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly extensions: MeExtensions,
  ) {}

  /** The User plus fields other features register (billing: `plan`, `aiQuota`, `limits`). */
  @Get()
  async get(@CurrentUser() user: AuthUser, @RequestTimezone() timeZone: string): Promise<UserDto & Record<string, unknown>> {
    const row = await this.users.get(user.id);
    const dto = toUserDto(row, await this.users.avatarUrlOf(row));
    return { ...dto, ...(await this.extensions.fields({ user, timeZone, now: new Date() })) };
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateProfileDto,
    @RequestTimezone() timeZone: string,
  ): Promise<UserDto & Record<string, unknown>> {
    const row = await this.users.update(user.id, body);
    const dto = toUserDto(row, await this.users.avatarUrlOf(row));
    return { ...dto, ...(await this.extensions.fields({ user, timeZone, now: new Date() })) };
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.deleteAccount(user.id);
  }
}
