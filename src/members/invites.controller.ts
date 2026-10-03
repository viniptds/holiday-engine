import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { DevAuthGuard } from '../app-trips/dev-auth.guard.js';
import { CurrentUser } from '../app-trips/current-user.decorator.js';
import { AppTripDto } from '../app-trips/app-trips.types.js';
import { InvitesService } from './invites.service.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import { InviteDto, InvitePreviewDto } from './members.types.js';

@Controller(APP_PREFIX)
@UseFilters(AppExceptionFilter)
@UseGuards(DevAuthGuard)
export class InvitesController {
  constructor(private readonly invites: InvitesService) {}

  @Post('trips/:id/invites')
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Param('id') tripId: string,
    @Body(appValidationPipe) body: CreateInviteDto,
  ): Promise<InviteDto> {
    return this.invites.create(user, tripId, body);
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
