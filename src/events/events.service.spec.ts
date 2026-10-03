import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { EventsService, scheduledWindow } from './events.service.js';
import { SuggestedEventsService } from './suggested-events.service.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { Event, EventsProvider, EventsSearch } from './events.types.js';

const trip = { id: 'trip-1', destination: 'Lisbon', startDate: '2026-11-10', endDate: '2026-11-15' };

describe('EventsService', () => {
  let search: jest.Mock<(query: EventsSearch) => Promise<Event[]>>;
  let findSent: jest.Mock<(tripId: string, externalIds: string[]) => Promise<Set<string>>>;
  let recordNew: jest.Mock<(tripId: string, externalIds: string[]) => Promise<Set<string>>>;
  let service: EventsService;

  beforeEach(async () => {
    search = jest.fn(async () => []);
    findSent = jest.fn(async () => new Set<string>());
    // By default every id passed in gets inserted (nothing recorded concurrently).
    recordNew = jest.fn(async (_tripId: string, ids: string[]) => new Set(ids));
    const provider: EventsProvider = { search };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: EVENTS_PROVIDER, useValue: provider },
        { provide: SuggestedEventsService, useValue: { findSent, recordNew } },
      ],
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

  it('looks at most 30 days past the window start on long trips', async () => {
    await service.suggestForRequest({ ...trip, endDate: '2027-06-30' }, new Date('2026-11-12T08:00:00.000Z'));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date('2026-11-12T00:00:00.000Z'),
        to: new Date('2026-12-12T23:59:59.999Z'),
      }),
    );
  });

  it('caps a future trip at 30 days past its startDate', async () => {
    await service.suggestForRequest({ ...trip, endDate: '2027-06-30' }, new Date('2026-10-03T08:00:00.000Z'));

    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date('2026-11-10T00:00:00.000Z'),
        to: new Date('2026-12-10T23:59:59.999Z'),
      }),
    );
  });

  it('uses the trip end when it comes before the 30-day cap', async () => {
    await service.suggestForRequest({ ...trip, endDate: '2026-12-09' }, new Date('2026-10-03T08:00:00.000Z'));

    expect(search).toHaveBeenCalledWith(expect.objectContaining({ to: new Date('2026-12-09T23:59:59.999Z') }));
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
    expect(recordNew).not.toHaveBeenCalled();
  });

  describe('suggestScheduled', () => {
    const makeEvent = (externalId: string): Event => ({
      externalId,
      name: externalId,
      startsAt: '2026-11-12T20:00:00.000Z',
      venue: null,
      city: 'Lisbon',
      url: null,
      category: null,
    });

    const ids = (events: Event[]) => events.map((e) => e.externalId);

    it('searches today through tomorrow, fetching up to 50 candidates', async () => {
      await service.suggestScheduled(trip, new Date('2026-11-12T09:00:00.000Z'));

      expect(search).toHaveBeenCalledWith({
        city: 'Lisbon',
        from: new Date('2026-11-12T00:00:00.000Z'),
        to: new Date('2026-11-13T23:59:59.999Z'),
        limit: 50,
      });
    });

    it('drops already-sent events, then keeps the first 5 and records only those', async () => {
      search.mockResolvedValue(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(makeEvent));
      findSent.mockResolvedValue(new Set(['a', 'c']));

      const events = await service.suggestScheduled(trip, new Date('2026-11-12T09:00:00.000Z'));

      expect(findSent).toHaveBeenCalledWith('trip-1', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
      expect(recordNew).toHaveBeenCalledWith('trip-1', ['b', 'd', 'e', 'f', 'g']);
      expect(ids(events)).toEqual(['b', 'd', 'e', 'f', 'g']);
    });

    it('leaves out events an overlapping run recorded in the meantime', async () => {
      search.mockResolvedValue(['a', 'b'].map(makeEvent));
      recordNew.mockResolvedValue(new Set(['b']));

      expect(ids(await service.suggestScheduled(trip, new Date('2026-11-12T09:00:00.000Z')))).toEqual(['b']);
    });

    it('returns nothing when every event was already sent', async () => {
      search.mockResolvedValue([makeEvent('a')]);
      findSent.mockResolvedValue(new Set(['a']));

      expect(await service.suggestScheduled(trip, new Date('2026-11-12T09:00:00.000Z'))).toEqual([]);
      expect(recordNew).toHaveBeenCalledWith('trip-1', []);
    });
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
