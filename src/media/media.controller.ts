import { Controller, Get, Param, Query, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { MediaService } from './media.service.js';
import { CityPhotosQueryDto, PlacePhotosQueryDto } from './media.dto.js';
import type { PhotoDto } from './media.types.js';

/** City and place photos for any signed-in user (docs/app-moments-spec.md §1). */
@Controller(`${APP_PREFIX}/media`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('city')
  async city(@CurrentUser() user: AuthUser, @Query(appValidationPipe) query: CityPhotosQueryDto): Promise<{ photos: PhotoDto[] }> {
    return { photos: await this.media.city(user, query.q, query.count ?? 1, query.size ?? 'large') };
  }

  @Get('place/:googlePlaceId')
  async place(
    @CurrentUser() user: AuthUser,
    @Param('googlePlaceId') googlePlaceId: string,
    @Query(appValidationPipe) query: PlacePhotosQueryDto,
  ): Promise<{ photos: PhotoDto[] }> {
    return { photos: await this.media.place(user, googlePlaceId, query.count ?? 1, query.size ?? 'large') };
  }
}
