import type { Event } from '../events/events.types.js';
import type { TripDto } from '../trips/trip.dto.js';

export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'INTERNAL';

/** Outbound `type` → `payload` (docs/trip-engine-contract.md). */
export type OutboundPayloads = {
  'trip.created': { trip: TripDto };
  'trip.list': { trips: TripDto[] };
  'trip.updated': { trip: TripDto };
  'trip.deleted': { tripId: string };
  'events.suggestions': { trip: TripDto; events: Event[]; trigger: 'request' | 'scheduled' };
  error: { code: ErrorCode; message: string; requestType: string };
};

export type OutboundType = keyof OutboundPayloads;

/** Envelope published on `bot-outbound`. `correlationId` is `null` for engine-initiated messages. */
export type OutboundMessage<T extends OutboundType = OutboundType> = {
  [K in T]: {
    type: K;
    provider: string;
    chatId: string;
    correlationId: string | null;
    payload: OutboundPayloads[K];
  };
}[T];
