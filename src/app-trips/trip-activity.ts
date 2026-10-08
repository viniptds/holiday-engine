import { Injectable, Logger } from '@nestjs/common';

/**
 * Writes other features react to after they're committed (achievements). `userId` is who did it.
 * - `trip.saved`: a trip was created or updated;
 * - `trip.itinerary`: its places changed (add, patch, delete, PUT, AI confirm);
 * - `member.joined`: `userId` joined `tripId`;
 * - `moment.completed`: `userId`'s moment became ready (or moved) on `tripId` (null = unassigned).
 */
export type TripActivityEvent =
  | { type: 'trip.saved'; tripId: string; userId: string }
  | { type: 'trip.itinerary'; tripId: string; userId: string }
  | { type: 'member.joined'; tripId: string; userId: string }
  | { type: 'moment.completed'; tripId: string | null; userId: string };

export type TripActivityListener = (event: TripActivityEvent) => Promise<void>;

/**
 * Registered on startup by the features that care. `emit` runs after the write committed and never
 * fails it: a listener error is logged (ids only) and swallowed.
 */
@Injectable()
export class TripActivity {
  private readonly logger = new Logger(TripActivity.name);
  private readonly listeners: TripActivityListener[] = [];

  register(listener: TripActivityListener): void {
    this.listeners.push(listener);
  }

  async emit(event: TripActivityEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (error) {
        this.logger.warn(`${event.type} for trip ${event.tripId ?? '-'} (user ${event.userId}): ${(error as Error).message}`);
      }
    }
  }
}
