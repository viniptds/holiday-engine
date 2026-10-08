import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AiModule } from '../ai/ai.module.js';
import { AI_CONFIG } from '../ai/ai.config.js';
import type { AiConfig } from '../ai/ai.config.js';
import type { FetchFn } from '../ai/llm/http-json.js';
import { GooglePhotoSource, MEDIA_FETCH, MockPhotoSource, PHOTO_SOURCE } from './photo-source.js';
import type { PhotoSource } from './photo-source.js';
import { MediaService } from './media.service.js';
import { MediaController } from './media.controller.js';
import { DestinationResolver } from './destination-resolver.js';

/** The photo source PLACES_PROVIDER selects (GOOGLE_PLACES_API_KEY for google). */
export function createPhotoSource(config: AiConfig, fetchFn: FetchFn): PhotoSource {
  return config.placesProvider === 'google' ? new GooglePhotoSource(config.placesApiKey, fetchFn) : new MockPhotoSource();
}

/** City and place photos, and destination lookups (country, city id) for the journey. */
@Module({
  imports: [TypeOrmModule.forFeature([Trip]), AuthModule, AiModule],
  controllers: [MediaController],
  providers: [
    { provide: MEDIA_FETCH, useValue: ((...args) => fetch(...args)) as FetchFn },
    { provide: PHOTO_SOURCE, inject: [AI_CONFIG, MEDIA_FETCH], useFactory: createPhotoSource },
    MediaService,
    DestinationResolver,
  ],
  exports: [DestinationResolver, PHOTO_SOURCE],
})
export class MediaModule {}
