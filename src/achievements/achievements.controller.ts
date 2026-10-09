import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { RequestTimezone } from '../app-common/timezone.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { StorageContext } from '../moments/request-base-url.js';
import type { StorageRequestContext } from '../moments/storage/object-storage.js';
import { AchievementsService } from './achievements.service.js';
import { AchievementEventDto, AchievementsSeenDto, JourneySkipDto } from './achievements.dto.js';
import type { AchievementDto, JourneyDto } from './achievements.types.js';

/** `/achievements/events` and `/achievements/seen`. */
@Controller(`${APP_PREFIX}/achievements`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class AchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Post('events')
  @HttpCode(HttpStatus.OK)
  async event(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: AchievementEventDto): Promise<{ achievements: AchievementDto[] }> {
    return { achievements: await this.achievements.event(user, body.tripId) };
  }

  @Post('seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  async seen(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: AchievementsSeenDto): Promise<void> {
    await this.achievements.markSeen(user, body.keys);
  }
}

/** `GET /me/achievements`. */
@Controller(`${APP_PREFIX}/me/achievements`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class MyAchievementsController {
  constructor(private readonly achievements: AchievementsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<{ achievements: AchievementDto[] }> {
    return { achievements: await this.achievements.list(user) };
  }
}

/** `GET /trips/:id/journey` (members). */
@Controller(`${APP_PREFIX}/trips/:tripId/journey`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class JourneyController {
  constructor(private readonly achievements: AchievementsService) {}

  @Get()
  journey(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @RequestLocale() locale: Locale,
    @RequestTimezone() timeZone: string,
    @StorageContext() context: StorageRequestContext,
  ): Promise<JourneyDto> {
    return this.achievements.journey(user, tripId, locale, timeZone, context);
  }

  /** Owners and editors: skip a skippable step for the whole trip → `200 { journey }`. */
  @Post('skips')
  @HttpCode(HttpStatus.OK)
  async skip(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Body(appValidationPipe) body: JourneySkipDto,
    @RequestLocale() locale: Locale,
    @RequestTimezone() timeZone: string,
    @StorageContext() context: StorageRequestContext,
  ): Promise<{ journey: JourneyDto }> {
    return { journey: await this.achievements.skip(user, tripId, body.key, locale, timeZone, context) };
  }

  @Delete('skips/:key')
  async unskip(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Param('key') key: string,
    @RequestLocale() locale: Locale,
    @RequestTimezone() timeZone: string,
    @StorageContext() context: StorageRequestContext,
  ): Promise<{ journey: JourneyDto }> {
    return { journey: await this.achievements.unskip(user, tripId, key, locale, timeZone, context) };
  }
}
