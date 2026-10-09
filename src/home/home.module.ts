import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AiModule } from '../ai/ai.module.js';
import { MediaModule } from '../media/media.module.js';
import { UsersModule } from '../users/users.module.js';
import { WizardModule } from '../wizard/wizard.module.js';
import type { FetchFn } from '../ai/llm/http-json.js';
import { BannersService } from './banners.service.js';
import { loadCatalog } from './catalog.js';
import { loadCopy } from './copy.js';
import { CopyRefreshService } from './copy-refresh.service.js';
import { HolidaysService } from './holidays.service.js';
import { HomeController } from './home.controller.js';
import { homeConfigFrom } from './home.config.js';
import { HomeCopy } from './home-copy.entity.js';
import { DESTINATION_CATALOG, HOME_CONFIG, HOME_COPY, HOME_FETCH } from './home.types.js';
import { TrendingService } from './trending.service.js';
import { WeatherService } from './weather.service.js';

/**
 * Home tab: weather and holiday proxies, the destination catalog, trip-idea banners, the optional
 * nightly copy refresh and the draft row. The catalog and the copy sets are loaded and validated
 * at startup (an invalid file fails boot naming every problem). Needs `ScheduleModule.forRoot()` in
 * the root module (for `SchedulerRegistry`, like SuggestionsModule).
 */
@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripMember, HomeCopy]), AuthModule, AiModule, MediaModule, UsersModule, WizardModule],
  controllers: [HomeController],
  providers: [
    { provide: HOME_CONFIG, inject: [ConfigService], useFactory: homeConfigFrom },
    { provide: HOME_FETCH, useValue: ((...args) => fetch(...args)) as FetchFn },
    { provide: DESTINATION_CATALOG, useFactory: () => loadCatalog() },
    { provide: HOME_COPY, useFactory: () => loadCopy() },
    WeatherService,
    HolidaysService,
    TrendingService,
    BannersService,
    CopyRefreshService,
  ],
  exports: [DESTINATION_CATALOG],
})
export class HomeModule {}
