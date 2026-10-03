import { Module } from '@nestjs/common';
import { TripsModule } from '../trips/trips.module.js';
import { EventsModule } from '../events/events.module.js';
import { OutboundModule } from '../outbound/outbound.module.js';
import { SuggestionsScheduler } from './suggestions.scheduler.js';

/** Needs `ScheduleModule.forRoot()` in the root module (for `SchedulerRegistry`). */
@Module({
  imports: [TripsModule, EventsModule, OutboundModule],
  providers: [SuggestionsScheduler],
})
export class SuggestionsModule {}
