import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestTimezone } from '../app-common/timezone.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { MomentsService } from './moments.service.js';
import { CreateMomentDto, ListMomentsQueryDto, PatchMomentDto } from './moments.dto.js';
import type { CreatedMomentDto, MomentDto } from './moments.types.js';
import { StorageContext } from './request-base-url.js';
import type { StorageRequestContext } from './storage/object-storage.js';

/** Moments (docs/app-moments-spec.md §2). */
@Controller(`${APP_PREFIX}/moments`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class MomentsController {
  constructor(private readonly moments: MomentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body(appValidationPipe) body: CreateMomentDto,
    @RequestTimezone() timeZone: string,
    @StorageContext() context: StorageRequestContext,
  ): Promise<CreatedMomentDto> {
    return this.moments.create(user, body, timeZone, context);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query(appValidationPipe) _query: ListMomentsQueryDto,
    @StorageContext() context: StorageRequestContext,
  ): Promise<{ moments: MomentDto[] }> {
    return { moments: await this.moments.listUnassigned(user, context) };
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  complete(@CurrentUser() user: AuthUser, @Param('id') id: string, @StorageContext() context: StorageRequestContext): Promise<MomentDto> {
    return this.moments.complete(user, id, context);
  }

  @Patch(':id')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(appValidationPipe) body: PatchMomentDto,
    @StorageContext() context: StorageRequestContext,
  ): Promise<MomentDto> {
    return this.moments.move(user, id, body.tripId, context);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.moments.delete(user, id);
  }
}

/** `GET /trips/:id/moments`: the trip's ready moments, for its members. */
@Controller(`${APP_PREFIX}/trips/:tripId/moments`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class TripMomentsController {
  constructor(private readonly moments: MomentsService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @StorageContext() context: StorageRequestContext,
  ): Promise<{ moments: MomentDto[] }> {
    return { moments: await this.moments.listTrip(user, tripId, context) };
  }
}
