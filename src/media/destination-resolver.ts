import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TtlLru } from '../app-common/ttl-lru.js';
import { PHOTO_SOURCE } from './photo-source.js';
import type { PhotoSource } from './photo-source.js';

/** A destination that failed to resolve isn't retried for an hour (per process). */
const RETRY_AFTER_FAILURE_MS = 60 * 60 * 1000;

/**
 * Sets `trips.countryCode` / `trips.cityPlaceId` from a Places lookup of the destination: when a
 * trip is saved, and lazily for older trips (explorer achievements). Best effort: a failure leaves
 * them null for a later try.
 */
@Injectable()
export class DestinationResolver {
  private readonly logger = new Logger(DestinationResolver.name);
  private readonly failed = new TtlLru<string, true>(10_000, RETRY_AFTER_FAILURE_MS);

  constructor(
    @Inject(PHOTO_SOURCE) private readonly source: PhotoSource,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
  ) {}

  /** Resolves the trip if it isn't yet; returns the trip with the stored values. */
  async ensure(trip: Trip): Promise<Trip> {
    if (trip.cityPlaceId || this.failed.get(trip.id)) return trip;
    try {
      const resolved = await this.source.resolveDestination(trip.destination);
      if (!resolved) {
        this.failed.set(trip.id, true);
        return trip;
      }
      // Only if the destination is still the one looked up (a concurrent edit resets them).
      await this.trips.update(
        { id: trip.id, destination: trip.destination, cityPlaceId: IsNull() },
        { countryCode: resolved.countryCode, cityPlaceId: resolved.placeId },
      );
      return Object.assign(trip, { countryCode: resolved.countryCode, cityPlaceId: resolved.placeId });
    } catch (error) {
      this.failed.set(trip.id, true);
      this.logger.warn(`Destination lookup failed for trip ${trip.id} (${this.source.name}): ${(error as Error).message}`);
      return trip;
    }
  }
}
