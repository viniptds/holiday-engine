import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppTripDto } from '../app-trips/app-trips.types.js';
import { InvitesService } from './invites.service.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { InviteDto, InvitePreviewDto, InviteSummaryDto } from './members.types.js';

@Controller(APP_PREFIX)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post('trips/:id/invites')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') tripId: string,
    @Body(appValidationPipe) body: CreateInviteDto,
    @RequestLocale() locale: Locale,
  ): Promise<InviteDto> {
    return this.invites.create(user, tripId, body, locale);
  }

  @Get('trips/:id/invites')
  async list(@CurrentUser() user: AuthUser, @Param('id') tripId: string): Promise<{ invites: InviteSummaryDto[] }> {
    return { invites: await this.invites.list(user, tripId) };
  }

  @Delete('trips/:id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@CurrentUser() user: AuthUser, @Param('id') tripId: string, @Param('inviteId') inviteId: string): Promise<void> {
    await this.invites.revoke(user, tripId, inviteId);
  }

  @Get('invites/:token')
  preview(@Param('token') token: string): Promise<InvitePreviewDto> {
    return this.invites.preview(token);
  }

  @Post('invites/:token/accept')
  @HttpCode(HttpStatus.OK)
  accept(@CurrentUser() user: AuthUser, @Param('token') token: string): Promise<AppTripDto> {
    return this.invites.accept(user, token);
  }
}
