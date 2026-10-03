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

@Controller(`${APP_PREFIX}/me`)
@UseFilters(AppExceptionFilter)
@UsePipes(appValidationPipe)
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  async get(@CurrentUser() user: AuthUser): Promise<UserDto> {
    return toUserDto(await this.users.get(user.id));
  }

  @Patch()
  async update(@CurrentUser() user: AuthUser, @Body() body: UpdateProfileDto): Promise<UserDto> {
    return toUserDto(await this.users.update(user.id, body));
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser): Promise<void> {
    await this.auth.deleteAccount(user.id);
  }
}
