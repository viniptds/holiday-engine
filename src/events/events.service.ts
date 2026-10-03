import { Inject, Injectable } from '@nestjs/common';
import { addUtcDays, endOfUtcDay, parseDateOnly, startOfUtcDay } from './events.dates.js';
import { EVENTS_PROVIDER } from './events.types.js';
import type { Event, EventsProvider, EventsTrip, EventsWindow } from './events.types.js';

export const REQUEST_SUGGESTIONS_LIMIT = 5;

/** Window for on-request suggestions: `[max(today, startDate), endDate]`, or `null` once the trip has ended. */
export function requestWindow(trip: EventsTrip, today: Date): EventsWindow | null {
  const start = parseDateOnly(trip.startDate);
  const from = start > today ? start : startOfUtcDay(today);
  const to = endOfUtcDay(parseDateOnly(trip.endDate));
  return from <= to ? { from, to } : null;
}

/** Window for scheduled suggestions: start of today through end of tomorrow (UTC). */
export function scheduledWindow(today: Date): EventsWindow {
  return { from: startOfUtcDay(today), to: endOfUtcDay(addUtcDays(today, 1)) };
}

@Injectable()
export class EventsService {
  constructor(@Inject(EVENTS_PROVIDER) private readonly provider: EventsProvider) {}

  /** Events for an `events.suggest` request. Nothing is marked as sent. */
  async suggestForRequest(trip: EventsTrip, today: Date = new Date()): Promise<Event[]> {
    const window = requestWindow(trip, today);
    if (!window) return [];
    return this.provider.search({ city: trip.destination, ...window, limit: REQUEST_SUGGESTIONS_LIMIT });
  }
}
