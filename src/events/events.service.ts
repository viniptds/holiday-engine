import { Inject, Injectable } from '@nestjs/common';
import { addUtcDays, endOfUtcDay, parseDateOnly, startOfUtcDay } from './events.dates.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { Event, EventsProvider, EventsTrip, EventsWindow } from './events.types.js';
import { SuggestedEventsService } from './suggested-events.service.js';

export const REQUEST_SUGGESTIONS_LIMIT = 5;
/** On-request searches look at most this many days past their start, however long the trip is. */
export const REQUEST_WINDOW_DAYS = 30;
export const SCHEDULED_SUGGESTIONS_LIMIT = 5;
/** Scheduled runs fetch this many candidates, so already-sent events don't crowd out new ones. */
export const SCHEDULED_SEARCH_LIMIT = 50;

/**
 * Window for on-request suggestions: `from = max(today, startDate)` through
 * `min(endDate, from + 30 days)`, or `null` once the trip has ended.
 */
export function requestWindow(trip: EventsTrip, today: Date): EventsWindow | null {
  const start = parseDateOnly(trip.startDate);
  const from = start > today ? start : startOfUtcDay(today);
  const end = endOfUtcDay(parseDateOnly(trip.endDate));
  const cap = endOfUtcDay(addUtcDays(from, REQUEST_WINDOW_DAYS));
  const to = end < cap ? end : cap;
  return from <= to ? { from, to } : null;
}

/** Window for scheduled suggestions: start of today through end of tomorrow (UTC). */
export function scheduledWindow(today: Date): EventsWindow {
  return { from: startOfUtcDay(today), to: endOfUtcDay(addUtcDays(today, 1)) };
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(EVENTS_PROVIDER) private readonly provider: EventsProvider,
    private readonly suggested: SuggestedEventsService,
  ) {}

  /** Events for an `events.suggest` request. Nothing is marked as sent. */
  async suggestForRequest(trip: EventsTrip, today: Date = new Date()): Promise<Event[]> {
    const window = requestWindow(trip, today);
    if (!window) return [];
    return this.provider.search({ city: trip.destination, ...window, limit: REQUEST_SUGGESTIONS_LIMIT });
  }

  /**
   * Events for the daily run: the first 5 events today or tomorrow not yet sent for the trip.
   * Records exactly the returned ones as sent.
   */
  async suggestScheduled(trip: EventsTrip, today: Date = new Date()): Promise<Event[]> {
    const candidates = await this.provider.search({
      city: trip.destination,
      ...scheduledWindow(today),
      limit: SCHEDULED_SEARCH_LIMIT,
    });
    const sent = await this.suggested.findSent(
      trip.id,
      candidates.map((event) => event.externalId),
    );
    const picked = candidates.filter((event) => !sent.has(event.externalId)).slice(0, SCHEDULED_SUGGESTIONS_LIMIT);
    // The insert ignores ids recorded meanwhile by an overlapping run, so each event is still sent once.
    const recorded = await this.suggested.recordNew(
      trip.id,
      picked.map((event) => event.externalId),
    );
    return picked.filter((event) => recorded.has(event.externalId));
  }
}
