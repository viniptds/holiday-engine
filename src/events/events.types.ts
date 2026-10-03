/** Contract `Event` JSON shape (docs/trip-engine-contract.md). */
export type Event = {
  externalId: string;
  name: string;
  startsAt: string;
  venue: string | null;
  city: string;
  url: string | null;
  category: string | null;
};

export type EventsSearch = { city: string; from: Date; to: Date; limit: number };

/** Source of events. `search` returns events with `startsAt` in `[from, to]`, sorted by `startsAt`, at most `limit`. */
export interface EventsProvider {
  search(query: EventsSearch): Promise<Event[]>;
}

export const EVENTS_PROVIDER = Symbol('EVENTS_PROVIDER');

/** The trip fields events need. Structural, so this module doesn't depend on `src/trips`. */
export type EventsTrip = { id: string; destination: string; startDate: string; endDate: string };

/** Inclusive time range. */
export type EventsWindow = { from: Date; to: Date };
