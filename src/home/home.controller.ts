import { Controller, Get, Headers, Query, UseFilters, UseGuards } from '@nestjs/common';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AiService } from '../ai/ai.service.js';
import { BannersService } from './banners.service.js';
import { BannersQueryDto, WeatherQueryDto } from './home.dto.js';
import { MAX_HOME_DRAFTS } from './home.types.js';
import type { BannersDto, HomeDto, WeatherDto } from './home.types.js';
import { WeatherService } from './weather.service.js';
import { roundCoordinate } from './weather.service.js';

/** The region of the first Accept-Language tag (`pt-BR` → `BR`), the last resort for the holiday country. */
export function localeRegion(acceptLanguage: string | undefined): string | null {
  const first = acceptLanguage?.split(',')[0]?.trim().split(';')[0] ?? '';
  const region = first.split(/[-_]/)[1];
  return region && /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : null;
}

/** Home tab (docs/app-home-spec.md). */
@Controller(`${APP_PREFIX}/home`)
@UseGuards(AuthGuard)
@UseFilters(AppExceptionFilter)
export class HomeController {
  constructor(
    private readonly ai: AiService,
    private readonly weatherService: WeatherService,
    private readonly bannersService: BannersService,
  ) {}

  /** The draft row: open AI conversations, newest first (at most 5). */
  @Get()
  async home(@CurrentUser() user: AuthUser): Promise<HomeDto> {
    const open = await this.ai.list(user, 'open');
    return { drafts: open.slice(0, MAX_HOME_DRAFTS), hasMoreDrafts: open.length > MAX_HOME_DRAFTS };
  }

  @Get('weather')
  weather(@Query(appValidationPipe) query: WeatherQueryDto, @RequestLocale() locale: Locale): Promise<WeatherDto> {
    if (query.city !== undefined) return this.weatherService.weather({ city: query.city }, locale);
    return this.weatherService.weather({ lat: query.lat!, lng: query.lng! }, locale);
  }

  @Get('banners')
  banners(
    @CurrentUser() user: AuthUser,
    @Query(appValidationPipe) query: BannersQueryDto,
    @RequestLocale() locale: Locale,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<BannersDto> {
    const position = query.lat !== undefined && query.lng !== undefined ? { lat: roundCoordinate(query.lat), lng: roundCoordinate(query.lng) } : null;
    return this.bannersService.banners(user, locale, position, localeRegion(acceptLanguage));
  }
}
