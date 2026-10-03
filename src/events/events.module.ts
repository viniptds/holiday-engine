import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EventsService } from './events.service.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { EventsProvider } from './events.types.js';
import { MockEventsProvider } from './mock-events.provider.js';
import { SuggestedEvent } from './suggested-event.entity.js';
import { SuggestedEventsService } from './suggested-events.service.js';

/** Implementations selectable through `EVENTS_PROVIDER`. */
const EVENTS_PROVIDERS: Record<string, () => EventsProvider> = {
  mock: () => new MockEventsProvider(),
};

export function createEventsProvider(name: string | undefined): EventsProvider {
  const key = name?.trim().toLowerCase() || 'mock';
  const create = EVENTS_PROVIDERS[key];
  if (!create) {
    throw new Error(
      `Unknown EVENTS_PROVIDER "${name}". Supported values: ${Object.keys(EVENTS_PROVIDERS).join(', ')}`,
    );
  }
  return create();
}

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([SuggestedEvent])],
  providers: [
    {
      provide: EVENTS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createEventsProvider(config.get<string>('EVENTS_PROVIDER')),
    },
    SuggestedEventsService,
    EventsService,
  ],
  exports: [EventsService],
})
export class EventsModule {}
