import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { EventsService, scheduledWindow } from './events.service.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { Event, EventsProvider, EventsSearch } from './events.types.js';

const trip = { id: 'trip-1', destination: 'Lisbon', startDate: '2026-11-10', endDate: '2026-11-15' };

describe('EventsService', () => {
  let search: jest.Mock<(query: EventsSearch) => Promise<Event[]>>;
  let service: EventsService;

  beforeEach(async () => {
    search = jest.fn(async () => []);
    const provider: EventsProvider = { search };
    const moduleRef = await Test.createTestingModule({
      providers: [EventsService, { provide: EVENTS_PROVIDER, useValue: provider }],
    }).compile();
    service = moduleRef.get(EventsService);
  });

  it('searches the whole trip when it is in the future', async () => {
    await service.suggestForRequest(trip, new Date('2026-10-03T08:30:00.000Z'));

    expect(search).toHaveBeenCalledWith({
      city: 'Lisbon',
      from: new Date('2026-11-10T00:00:00.000Z'),
      to: new Date('2026-11-15T23:59:59.999Z'),
      limit: 5,
    });
  });

  it('starts from today when the trip has already started', async () => {
    await service.suggestForRequest(trip, new Date('2026-11-12T18:45:00.000Z'));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date('2026-11-12T00:00:00.000Z'),
        to: new Date('2026-11-15T23:59:59.999Z'),
      }),
    );
  });

  it('still searches on the last day of the trip', async () => {
    await service.suggestForRequest(trip, new Date('2026-11-15T22:00:00.000Z'));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ from: new Date('2026-11-15T00:00:00.000Z') }),
    );
  });

  it('returns nothing without searching once the trip has ended', async () => {
    const events = await service.suggestForRequest(trip, new Date('2026-11-16T00:00:00.000Z'));

    expect(events).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns what the provider found', async () => {
    const event: Event = {
      externalId: 'x',
      name: 'Fado Night',
      startsAt: '2026-11-11T20:00:00.000Z',
      venue: null,
      city: 'Lisbon',
      url: null,
      category: 'music',
    };
    search.mockResolvedValue([event]);

    expect(await service.suggestForRequest(trip, new Date('2026-10-03T00:00:00.000Z'))).toEqual([event]);
  });
});

describe('scheduledWindow', () => {
  it('covers today through the end of tomorrow (UTC)', () => {
    expect(scheduledWindow(new Date('2026-12-31T09:00:00.000Z'))).toEqual({
      from: new Date('2026-12-31T00:00:00.000Z'),
      to: new Date('2027-01-01T23:59:59.999Z'),
    });
  });
});
