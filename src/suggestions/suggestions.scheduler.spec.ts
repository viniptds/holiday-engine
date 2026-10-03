import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { CronJob } from 'cron';
import { SuggestionsScheduler, SUGGESTIONS_JOB } from './suggestions.scheduler.js';
import { TripsService } from '../trips/trips.service.js';
import { Trip } from '../trips/trip.entity.js';
import { EventsService } from '../events/events.service.js';
import type { Event } from '../events/events.types.js';
import { OutboundPublisher } from '../outbound/outbound.publisher.js';

const makeTrip = (id: string, chatId: string) =>
  Object.assign(new Trip(), {
    id,
    provider: 'telegram',
    chatId,
    destination: 'Lisbon',
    startDate: '2026-11-10',
    endDate: '2026-11-15',
    notes: null,
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
    updatedAt: new Date('2026-10-03T10:00:00.000Z'),
  });
const event = (externalId: string): Event => ({
  externalId,
  name: externalId,
  startsAt: '2026-11-12T20:00:00.000Z',
  venue: null,
  city: 'Lisbon',
  url: null,
  category: null,
});

const now = new Date('2026-11-12T09:00:00.000Z');

describe('SuggestionsScheduler', () => {
  const findActiveOn = jest.fn(async (_date: string): Promise<Trip[]> => []);
  const suggestScheduled = jest.fn(async (_trip: Trip, _today: Date): Promise<Event[]> => []);
  const publish = jest.fn(async (..._args: unknown[]) => undefined);
  const config = { get: jest.fn((_key: string): string | undefined => undefined) };
  let registry: SchedulerRegistry;
  let scheduler: SuggestionsScheduler;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        SuggestionsScheduler,
        SchedulerRegistry,
        { provide: ConfigService, useValue: config },
        { provide: TripsService, useValue: { findActiveOn } },
        { provide: EventsService, useValue: { suggestScheduled } },
        { provide: OutboundPublisher, useValue: { publish } },
      ],
    }).compile();
    scheduler = moduleRef.get(SuggestionsScheduler);
    registry = moduleRef.get(SchedulerRegistry);
  });

  afterEach(() => {
    if (registry.doesExist('cron', SUGGESTIONS_JOB)) registry.deleteCronJob(SUGGESTIONS_JOB);
  });

  describe('run', () => {
    it('looks up trips active today (UTC)', async () => {
      await scheduler.run(new Date('2026-11-12T23:30:00.000Z'));

      expect(findActiveOn).toHaveBeenCalledWith('2026-11-12');
    });

    it('publishes events.suggestions with trigger "scheduled" and no correlation id', async () => {
      const trip = makeTrip('t1', '111');
      findActiveOn.mockResolvedValueOnce([trip]);
      suggestScheduled.mockResolvedValueOnce([event('a')]);

      await scheduler.run(now);

      expect(suggestScheduled).toHaveBeenCalledWith(trip, now);
      expect(publish).toHaveBeenCalledWith(
        { provider: 'telegram', chatId: '111', correlationId: null },
        'events.suggestions',
        {
          trip: expect.objectContaining({ id: 't1', destination: 'Lisbon', createdAt: '2026-10-03T10:00:00.000Z' }),
          events: [event('a')],
          trigger: 'scheduled',
        },
      );
    });

    it('publishes nothing for a trip with no new events', async () => {
      findActiveOn.mockResolvedValueOnce([makeTrip('t1', '111')]);

      await scheduler.run(now);

      expect(publish).not.toHaveBeenCalled();
    });

    it('keeps going after one trip fails', async () => {
      findActiveOn.mockResolvedValueOnce([makeTrip('t1', '111'), makeTrip('t2', '222'), makeTrip('t3', '333')]);
      suggestScheduled
        .mockRejectedValueOnce(new Error('provider down'))
        .mockResolvedValueOnce([event('b')])
        .mockResolvedValueOnce([event('c')]);
      publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('redis down'));

      await expect(scheduler.run(now)).resolves.toBeUndefined();

      expect(suggestScheduled).toHaveBeenCalledTimes(3);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Scheduled suggestions failed for trip t1',
        expect.stringContaining('provider down'),
      );
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        'Scheduled suggestions failed for trip t3',
        expect.stringContaining('redis down'),
      );
    });
  });

  describe('cron registration', () => {
    it('registers the default daily 09:00 UTC job', () => {
      scheduler.onApplicationBootstrap();

      const job = registry.getCronJob(SUGGESTIONS_JOB) as CronJob;
      expect(job.cronTime.source).toBe('0 9 * * *');
      expect(job.cronTime.timeZone).toBe('UTC');
      expect(job.isActive).toBe(true);
    });

    it('uses SUGGESTIONS_CRON when set', () => {
      config.get.mockImplementation((key) => (key === 'SUGGESTIONS_CRON' ? '*/5 * * * *' : undefined));

      scheduler.onApplicationBootstrap();

      expect((registry.getCronJob(SUGGESTIONS_JOB) as CronJob).cronTime.source).toBe('*/5 * * * *');
      config.get.mockReset();
    });

    it('fails startup on an invalid expression', () => {
      config.get.mockImplementation((key) => (key === 'SUGGESTIONS_CRON' ? 'every day' : undefined));

      expect(() => scheduler.onApplicationBootstrap()).toThrow();
      config.get.mockReset();
    });
  });
});
