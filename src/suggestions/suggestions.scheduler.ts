import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { TripsService } from '../trips/trips.service.js';
import { toTripDto } from '../trips/trip.dto.js';
import { EventsService } from '../events/events.service.js';
import { formatDateOnly } from '../events/events.dates.js';
import { OutboundPublisher } from '../outbound/outbound.publisher.js';

export const DEFAULT_SUGGESTIONS_CRON = '0 9 * * *';
export const SUGGESTIONS_JOB = 'scheduled-event-suggestions';

/**
 * Daily run (`SUGGESTIONS_CRON`, UTC): sends each trip in progress the events for today and
 * tomorrow that it hasn't been sent yet. Registered at runtime because the expression comes from config.
 */
@Injectable()
export class SuggestionsScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SuggestionsScheduler.name);

  constructor(
    private readonly config: ConfigService,
    private readonly registry: SchedulerRegistry,
    private readonly trips: TripsService,
    private readonly events: EventsService,
    private readonly outbound: OutboundPublisher,
  ) {}

  onApplicationBootstrap() {
    const cronTime = this.config.get<string>('SUGGESTIONS_CRON') || DEFAULT_SUGGESTIONS_CRON;
    // An invalid expression throws here, failing startup with cron's error message.
    const job = CronJob.from({
      cronTime,
      timeZone: 'UTC',
      waitForCompletion: true,
      onTick: () => this.run(),
      errorHandler: (error) => this.logger.error('Scheduled suggestions run failed', String(error)),
    });
    this.registry.addCronJob(SUGGESTIONS_JOB, job);
    job.start();
    this.logger.log(`Event suggestions scheduled with "${cronTime}" (UTC)`);
  }

  /** One run. A failure on one trip is logged and doesn't stop the others. */
  async run(now: Date = new Date()): Promise<void> {
    const trips = await this.trips.findActiveOn(formatDateOnly(now));
    for (const trip of trips) {
      try {
        const events = await this.events.suggestScheduled(trip, now);
        if (events.length === 0) continue;
        await this.outbound.publish(
          { provider: trip.provider, chatId: trip.chatId, correlationId: null },
          'events.suggestions',
          { trip: toTripDto(trip), events, trigger: 'scheduled' },
        );
      } catch (error) {
        this.logger.error(
          `Scheduled suggestions failed for trip ${trip.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }
}
