import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { AppTripsService } from './app-trips.service.js';
import { CreateAppTripDto } from './dto/create-app-trip.dto.js';
import { UpdateAppTripDto } from './dto/update-app-trip.dto.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AppTripDto } from './app-trips.types.js';

/**
 * App API trips (`docs/app-api-contract.md`). Access is by trip membership; see `AppTripsService`.
 * Every `Trip` response is in the request's language (`Accept-Language`, `@RequestLocale()`).
 */
@Controller(`${APP_PREFIX}/trips`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class AppTripsController {
  constructor(private readonly trips: AppTripsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @RequestLocale() locale: Locale): Promise<{ trips: AppTripDto[] }> {
    return { trips: await this.trips.list(user, locale) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() user: AuthUser,
    @Body(appValidationPipe) body: CreateAppTripDto,
    @RequestLocale() locale: Locale,
  ): Promise<AppTripDto> {
    return this.trips.create(user, body, locale);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string, @RequestLocale() locale: Locale): Promise<AppTripDto> {
    return this.trips.get(user, id, locale);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(appValidationPipe) body: UpdateAppTripDto,
    @RequestLocale() locale: Locale,
  ): Promise<AppTripDto> {
    return this.trips.update(user, id, body, locale);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.trips.delete(user, id);
  }
}
