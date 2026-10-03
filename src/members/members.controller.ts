import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { DevAuthGuard } from '../app-trips/dev-auth.guard.js';
import { CurrentUser } from '../app-trips/current-user.decorator.js';
import { MembersService } from './members.service.js';
import { UpdateMemberDto } from './dto/update-member.dto.js';
import { MemberDto } from './members.types.js';

@Controller(`${APP_PREFIX}/trips/:id/members`)
@UseFilters(AppExceptionFilter)
@UseGuards(DevAuthGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('id') tripId: string): Promise<{ members: MemberDto[] }> {
    return { members: await this.members.list(user, tripId) };
  }

  @Patch(':userId')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') tripId: string,
    @Param('userId') userId: string,
    @Body(appValidationPipe) body: UpdateMemberDto,
  ): Promise<MemberDto> {
    return this.members.updateRole(user, tripId, userId, body.role);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param('id') tripId: string, @Param('userId') userId: string): Promise<void> {
    await this.members.remove(user, tripId, userId);
  }
}
