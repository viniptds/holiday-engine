import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Trip } from '../trips/trip.entity.js';

/** Runs inside the trip update's transaction, with the trip row locked and the new dates saved. */
export type TripDatesChangedHook = (manager: EntityManager, trip: Trip) => Promise<void>;

/**
 * Work other features do when a trip's dates change (the itinerary moves places off days that no
 * longer exist). Registered on startup; `AppTripsService.update` runs them in its transaction.
 */
@Injectable()
export class TripScheduleHooks {
  private readonly hooks: TripDatesChangedHook[] = [];

  register(hook: TripDatesChangedHook): void {
    this.hooks.push(hook);
  }

  get any(): boolean {
    return this.hooks.length > 0;
  }

  async datesChanged(manager: EntityManager, trip: Trip): Promise<void> {
    for (const hook of this.hooks) await hook(manager, trip);
  }
}
