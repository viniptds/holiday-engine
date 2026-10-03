import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MessagesRouter } from './messages.router.js';
import type { InboundMessage } from './messages.router.js';
import { TripsService } from '../trips/trips.service.js';
import { TripNotFoundError, TripValidationError } from '../trips/trips.errors.js';
import { Trip } from '../trips/trip.entity.js';
import { EventsService } from '../events/events.service.js';
import type { Event } from '../events/events.types.js';
import { OutboundPublisher } from '../outbound/outbound.publisher.js';

const TRIP_ID = '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';
const CORRELATION_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const owner = { provider: 'telegram', chatId: '905820592' };

const trip = Object.assign(new Trip(), {
  id: TRIP_ID,
  ...owner,
  destination: 'Lisbon',
  startDate: '2026-11-01',
  endDate: '2026-11-05',
  notes: null,
  createdAt: new Date('2026-10-03T10:00:00.000Z'),
  updatedAt: new Date('2026-10-03T10:00:00.000Z'),
});
const tripDto = {
  id: TRIP_ID,
  destination: 'Lisbon',
  startDate: '2026-11-01',
  endDate: '2026-11-05',
  notes: null,
  createdAt: '2026-10-03T10:00:00.000Z',
};
const event: Event = {
  externalId: 'e1',
  name: 'Fado Night',
  startsAt: '2026-11-02T20:00:00.000Z',
  venue: null,
  city: 'Lisbon',
  url: null,
  category: 'music',
};

const message = (type: string, payload: Record<string, unknown> = {}): InboundMessage =>
  ({ type, ...owner, correlationId: CORRELATION_ID, payload }) as InboundMessage;

describe('MessagesRouter', () => {
  const trips = {
    create: jest.fn(async (..._args: unknown[]) => trip),
    listForChat: jest.fn(async (..._args: unknown[]) => [trip]),
    update: jest.fn(async (..._args: unknown[]) => trip),
    delete: jest.fn(async (..._args: unknown[]) => undefined),
    getForChat: jest.fn(async (..._args: unknown[]) => trip),
  };
  const events = { suggestForRequest: jest.fn(async (..._args: unknown[]) => [event]) };
  const publish = jest.fn(async (..._args: unknown[]) => undefined);
  let router: MessagesRouter;

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      providers: [
        MessagesRouter,
        { provide: TripsService, useValue: trips },
        { provide: EventsService, useValue: events },
        { provide: OutboundPublisher, useValue: { publish } },
      ],
    }).compile();
    router = moduleRef.get(MessagesRouter);
  });

  /** The single reply published for the last routed message. */
  const reply = () => {
    expect(publish).toHaveBeenCalledTimes(1);
    const [target, type, payload] = publish.mock.calls[0];
    expect(target).toMatchObject({ ...owner, correlationId: CORRELATION_ID });
    return { type, payload };
  };

  describe('happy paths', () => {
    it('trip.create creates the trip (trimmed destination) and replies trip.created', async () => {
      await router.route(
        message('trip.create', { destination: ' Lisbon ', startDate: '2026-11-01', endDate: '2026-11-05' }),
      );

      expect(trips.create).toHaveBeenCalledWith(
        owner,
        expect.objectContaining({ destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' }),
      );
      expect(reply()).toEqual({ type: 'trip.created', payload: { trip: tripDto } });
    });

    it('trip.list replies with the chat trips', async () => {
      await router.route(message('trip.list'));

      expect(trips.listForChat).toHaveBeenCalledWith(owner);
      expect(reply()).toEqual({ type: 'trip.list', payload: { trips: [tripDto] } });
    });

    it('trip.update passes the validated changes and replies trip.updated', async () => {
      await router.route(message('trip.update', { tripId: TRIP_ID, notes: null }));

      expect(trips.update).toHaveBeenCalledWith(owner, expect.objectContaining({ tripId: TRIP_ID, notes: null }));
      expect(reply()).toEqual({ type: 'trip.updated', payload: { trip: tripDto } });
    });

    it('trip.delete deletes and replies trip.deleted', async () => {
      await router.route(message('trip.delete', { tripId: TRIP_ID }));

      expect(trips.delete).toHaveBeenCalledWith(owner, TRIP_ID);
      expect(reply()).toEqual({ type: 'trip.deleted', payload: { tripId: TRIP_ID } });
    });

    it('events.suggest replies events.suggestions with trigger "request"', async () => {
      await router.route(message('events.suggest', { tripId: TRIP_ID }));

      expect(trips.getForChat).toHaveBeenCalledWith(owner, TRIP_ID);
      expect(events.suggestForRequest).toHaveBeenCalledWith(trip, expect.any(Date));
      expect(reply()).toEqual({
        type: 'events.suggestions',
        payload: { trip: tripDto, events: [event], trigger: 'request' },
      });
    });

    it('drops payload fields the DTO does not declare', async () => {
      await router.route(message('trip.update', { tripId: TRIP_ID, chatId: 'someone-else' }));

      expect(trips.update.mock.calls[0][1]).not.toHaveProperty('chatId');
    });
  });

  describe('errors (published as `error`, never thrown)', () => {
    it.each([
      ['trip.create', { destination: '   ', startDate: '2026-11-01', endDate: '2026-11-05' }, 'destination should not be empty'],
      ['trip.create', { destination: 'Lisbon', startDate: '2026-11-05', endDate: '2026-11-01' }, 'endDate must be on or after startDate'],
      ['trip.update', { tripId: TRIP_ID, destination: null }, 'destination'],
      ['trip.delete', { tripId: 'nope' }, 'tripId must be a UUID'],
      ['events.suggest', {}, 'tripId must be a UUID'],
    ])('%s with an invalid payload → VALIDATION', async (type, payload, text) => {
      await router.route(message(type, payload));

      const { type: replyType, payload: error } = reply();
      expect(replyType).toBe('error');
      expect(error).toEqual({ code: 'VALIDATION', message: expect.stringContaining(text), requestType: type });
      expect(trips.create).not.toHaveBeenCalled();
      expect(trips.update).not.toHaveBeenCalled();
      expect(trips.delete).not.toHaveBeenCalled();
    });

    it('a service-level rule violation → VALIDATION', async () => {
      trips.update.mockRejectedValueOnce(new TripValidationError('endDate must be on or after startDate'));

      await router.route(message('trip.update', { tripId: TRIP_ID, endDate: '2026-10-01' }));

      expect(reply()).toEqual({
        type: 'error',
        payload: { code: 'VALIDATION', message: 'endDate must be on or after startDate', requestType: 'trip.update' },
      });
    });

    it.each([
      ['trip.update', { tripId: TRIP_ID, destination: 'Porto' }, trips.update],
      ['trip.delete', { tripId: TRIP_ID }, trips.delete],
      ['events.suggest', { tripId: TRIP_ID }, trips.getForChat],
    ])('%s for a trip the chat does not own → NOT_FOUND', async (type, payload, method) => {
      method.mockRejectedValueOnce(new TripNotFoundError(TRIP_ID));

      await router.route(message(type, payload));

      expect(reply()).toEqual({
        type: 'error',
        payload: { code: 'NOT_FOUND', message: `Trip ${TRIP_ID} not found`, requestType: type },
      });
    });

    it('an unexpected failure is logged and → INTERNAL without leaking details', async () => {
      trips.listForChat.mockRejectedValueOnce(new Error('connection terminated'));

      await expect(router.route(message('trip.list'))).resolves.toBeUndefined();

      const { payload } = reply();
      expect(payload).toEqual({ code: 'INTERNAL', message: expect.any(String), requestType: 'trip.list' });
      expect(JSON.stringify(payload)).not.toContain('connection terminated');
      expect(Logger.prototype.error).toHaveBeenCalled();
    });

    it('an unknown type (bypassing the HTTP envelope check) → VALIDATION', async () => {
      await router.route(message('trip.explode'));

      expect(reply().payload).toMatchObject({ code: 'VALIDATION', requestType: 'trip.explode' });
    });

    it('a failure to publish the reply propagates, so the job fails and is logged', async () => {
      publish.mockRejectedValueOnce(new Error('redis down'));

      await expect(router.route(message('trip.list'))).rejects.toThrow('redis down');
    });
  });
});
