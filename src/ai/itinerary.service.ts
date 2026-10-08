import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, Repository } from 'typeorm';
import { AppError, conflict, paymentRequired } from '../app-common/app-error.js';
import { BillingService } from '../billing/billing.service.js';
import type { AuthUser } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween } from '../trips/dto/date-rules.js';
import { MAX_SEARCH_RESULTS, MAX_TRIP_PLACES, SEARCH_RATE_LIMIT } from './ai.types.js';
import type { ItineraryDto, PlaceCategory, PlaceSearchResultDto, PlaceSource, TripPlaceDto } from './ai.types.js';
import { compareTripPlaces, toTripPlaceDto } from './ai.mapper.js';
import { normalizeName } from './draft.js';
import { TripPlace } from './entities/trip-place.entity.js';
import { AddPlaceDto, PatchPlaceDto, PutItineraryDto } from './dto/places.dto.js';
import { deriveCategory, INCLUDED_TYPE } from './places/categories.js';
import { PLACES_PROVIDER } from './places/places-provider.js';
import type { LatLng, PlaceMatch, PlacesDirectory } from './places/places-provider.js';
import { distanceKm, MAX_DISTANCE_KM } from './places/places-verifier.js';

const LOCK = { mode: 'pessimistic_write' } as const;
const MAX_CACHED_CENTERS = 1000;
const MAX_TRACKED_SEARCHERS = 10_000;

const placeNotFound = () => new AppError('NOT_FOUND', 'Place not found');
const tripNotFound = () => new AppError('NOT_FOUND', 'Trip not found');
const alreadyInTrip = () => conflict('ALREADY_IN_TRIP', 'Already in this trip');
const tripFull = () => conflict('TRIP_PLACES_LIMIT', `A trip can hold at most ${MAX_TRIP_PLACES} places`);
const plusRequired = (limit: number) =>
  paymentRequired('TRIP_PLACES_PLUS_REQUIRED', `The trip owner's plan allows ${limit} places`, { limit });
const placesUnavailable = () =>
  new AppError('AI_UNAVAILABLE', 'Place search is unavailable right now. Please try again in a moment.');
const invalid = (fields: Record<string, string>) => new AppError('VALIDATION', 'Some fields are invalid', fields);

/** Days of a trip: 1…tripDays. */
export const tripDays = (trip: Pick<Trip, 'startDate' | 'endDate'>) => daysBetween(trip.startDate, trip.endDate) + 1;

const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown })?.code === '23505' || (error as { driverError?: { code?: unknown } })?.driverError?.code === '23505';

/** A place to append to a trip's itinerary (user add or AI accept). */
export type NewTripPlace = {
  match: PlaceMatch;
  category: PlaceCategory;
  /** The wished day; null (or a day the trip doesn't have) → Unplanned. */
  day: number | null;
  startTime?: string | null;
  notes: string | null;
  source: PlaceSource;
};

/**
 * Trip places and their itinerary (docs/app-itinerary-spec.md). Members read; owners and editors
 * write. Every itinerary change (add, delete, PUT, AI accept, a date change) runs in one transaction
 * with the trip row locked and bumps `trips.itineraryVersion`; PUT checks the version under that lock.
 */
@Injectable()
export class ItineraryService {
  private readonly logger = new Logger(ItineraryService.name);
  /** `${tripId}|${destination key}` → centre. Insertion-ordered: the oldest is evicted first. */
  private readonly centers = new Map<string, LatLng>();
  /** userId → times of their recent searches (per process). */
  private readonly searches = new Map<string, number[]>();

  constructor(
    @InjectRepository(TripPlace) private readonly places: Repository<TripPlace>,
    @Inject(PLACES_PROVIDER) private readonly provider: PlacesDirectory,
    private readonly appTrips: AppTripsService,
    private readonly billing: BillingService,
    @Optional() private readonly activity?: TripActivity,
  ) {}

  /** The itinerary: places by day (Unplanned last) then position, and its version. */
  async list(user: AuthUser, tripId: string): Promise<ItineraryDto> {
    // The version is read before the places, so it's never newer than them: a PUT based on this
    // listing can only be refused as stale, never accepted over a change the listing missed.
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    const rows = await this.places.find({ where: { tripId: trip!.id } });
    return { places: rows.sort(compareTripPlaces).map(toTripPlaceDto), itineraryVersion: trip!.itineraryVersion ?? 0 };
  }

  /**
   * Google Text Search near the trip's destination, at most 10 results. Owners and editors;
   * 60 searches per user per rolling hour (RATE_LIMITED with Retry-After).
   */
  async search(user: AuthUser, tripId: string, query: string, category: PlaceCategory | undefined, locale: Locale): Promise<PlaceSearchResultDto[]> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    this.takeSearchSlot(user.id);

    let center: LatLng | null = null;
    try {
      center = await this.center(trip!, locale);
    } catch (error) {
      // Searching without the bias is still useful.
      this.logger.warn(`Places: destination lookup failed for trip ${trip!.id}: ${(error as Error).message}`);
    }
    let matches: PlaceMatch[];
    try {
      matches = await this.provider.searchMany({
        query,
        languageCode: locale,
        limit: MAX_SEARCH_RESULTS,
        includedType: category ? INCLUDED_TYPE[category] : undefined,
        ...(center ? { near: { center, radiusMeters: MAX_DISTANCE_KM * 1000 } } : {}),
      });
    } catch (error) {
      this.logger.warn(`Places: search failed for trip ${trip!.id}: ${(error as Error).message}`);
      throw placesUnavailable();
    }
    const existing = new Set((await this.places.find({ where: { tripId: trip!.id } })).map((p) => p.googlePlaceId));
    return matches.slice(0, MAX_SEARCH_RESULTS).map((match) => {
      const derived = deriveCategory(match.types);
      return {
        googlePlaceId: match.googlePlaceId,
        name: match.name,
        address: match.address,
        lat: match.location.lat,
        lng: match.location.lng,
        rating: match.rating,
        types: match.types,
        suggestedCategory: derived === 'other' && category ? category : derived,
        alreadyInTrip: existing.has(match.googlePlaceId),
      };
    });
  }

  /**
   * Adds a place the user picked: re-fetched from Google (Place Details), within 50 km of the
   * destination, not already in the trip, at most 200 per trip (409) and at most the trip OWNER's
   * plan limit (402 TRIP_PLACES_PLUS_REQUIRED with `limit`); appended at the end of its day.
   * A trip already over its plan limit keeps its places; only additions are refused.
   */
  async add(user: AuthUser, tripId: string, data: AddPlaceDto, locale: Locale): Promise<TripPlaceDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    // Cheap checks first, so a request that can't succeed costs no Google call.
    const current = await this.places.find({ where: { tripId: trip!.id } });
    if (current.some((p) => p.googlePlaceId === data.googlePlaceId)) throw alreadyInTrip();
    if (current.length >= MAX_TRIP_PLACES) throw tripFull();
    const planLimit = await this.billing.tripPlacesLimit(trip!.ownerUserId);
    if (current.length >= planLimit) throw plusRequired(planLimit);
    if (data.day != null && data.day > tripDays(trip!)) throw invalid({ day: `day must be between 1 and ${tripDays(trip!)}` });

    let match: PlaceMatch | null;
    let center: LatLng | null;
    try {
      match = await this.provider.details(data.googlePlaceId, locale);
      center = match ? await this.center(trip!, locale) : null;
    } catch (error) {
      this.logger.warn(`Places: lookup failed for trip ${trip!.id}: ${(error as Error).message}`);
      throw placesUnavailable();
    }
    if (!match) throw invalid({ googlePlaceId: 'Place not found' });
    if (center && distanceKm(center, match.location) > MAX_DISTANCE_KM) {
      throw invalid({ googlePlaceId: `This place is more than ${MAX_DISTANCE_KM} km from the trip's destination` });
    }

    const id = await this.places.manager.transaction(async (manager) => {
      const locked = await this.lockTrip(manager, trip!.id);
      // The dates may have changed since the first check.
      if (data.day != null && data.day > tripDays(locked)) throw invalid({ day: `day must be between 1 and ${tripDays(locked)}` });
      const limit = await this.billing.tripPlacesLimit(locked.ownerUserId, manager);
      const { added, ids, skippedForPlan } = await this.append(manager, locked, user.id, limit, [
        {
          match,
          category: data.category ?? deriveCategory(match.types),
          day: data.day ?? null,
          startTime: data.startTime ?? null,
          notes: data.notes ?? null,
          source: 'user',
        },
      ]);
      if (added === 0) {
        // Lost a race with another add of the same place, or the trip filled up.
        const count = (await manager.find(TripPlace, { where: { tripId: locked.id } })).length;
        if (count >= MAX_TRIP_PLACES) throw tripFull();
        throw skippedForPlan > 0 ? plusRequired(limit) : alreadyInTrip();
      }
      return ids[0];
    }).catch((error: unknown) => {
      if (isUniqueViolation(error)) throw alreadyInTrip();
      throw error;
    });
    const place = await this.places.findOne({ where: { id } });
    await this.activity?.emit({ type: 'trip.itinerary', tripId: trip!.id, userId: user.id });
    return toTripPlaceDto(place!);
  }

  /** Category, start time and note. Not an itinerary order change, so the version stays. */
  async patch(user: AuthUser, tripId: string, placeId: string, data: PatchPlaceDto): Promise<TripPlaceDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    if (!isUUID(placeId, '4')) throw placeNotFound();
    const changes: Partial<TripPlace> = {};
    if (data.category !== undefined) changes.category = data.category;
    if (data.startTime !== undefined) changes.startTime = data.startTime;
    if (data.notes !== undefined) changes.notes = data.notes;
    const where = { id: placeId.toLowerCase(), tripId: trip!.id };
    if (Object.keys(changes).length > 0) {
      const { affected } = await this.places.update(where, changes);
      if (!affected) throw placeNotFound();
    }
    const place = await this.places.findOne({ where });
    if (!place) throw placeNotFound();
    return toTripPlaceDto(place);
  }

  /** Removes a place; the later places of its day move up. */
  async remove(user: AuthUser, tripId: string, placeId: string): Promise<void> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    if (!isUUID(placeId, '4')) throw placeNotFound();
    await this.places.manager.transaction(async (manager) => {
      const locked = await this.lockTrip(manager, trip!.id);
      const place = await manager.findOne(TripPlace, { where: { id: placeId.toLowerCase(), tripId: locked.id } });
      if (!place) throw placeNotFound();
      await manager.delete(TripPlace, { id: place.id });
      const sameDay = (await manager.find(TripPlace, { where: { tripId: locked.id } }))
        .filter((p) => (p.day ?? null) === (place.day ?? null))
        .sort(compareTripPlaces);
      await this.renumber(manager, sameDay);
      await this.bump(manager, locked);
    });
    await this.activity?.emit({ type: 'trip.itinerary', tripId: trip!.id, userId: user.id });
  }

  /**
   * Replaces the whole ordering. Every place of the trip exactly once, valid days only, at the
   * current version (else CONFLICT naming the current version). Positions 0…n-1 per day as given.
   */
  async putItinerary(user: AuthUser, tripId: string, data: PutItineraryDto): Promise<ItineraryDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const result = await this.places.manager.transaction(async (manager) => {
      const locked = await this.lockTrip(manager, trip!.id);
      const version = locked.itineraryVersion ?? 0;
      if (data.itineraryVersion !== version) {
        throw conflict('STALE_ITINERARY', `The itinerary changed (current version ${version}); reload it and try again`, {
          itineraryVersion: String(version),
        });
      }

      const days = tripDays(locked);
      const seenDays = new Set<number | null>();
      for (const group of data.days) {
        if (group.day !== null && group.day > days) throw invalid({ days: `day ${group.day} isn't in this trip (1-${days})` });
        if (seenDays.has(group.day)) throw invalid({ days: `day ${group.day ?? 'null'} is listed twice` });
        seenDays.add(group.day);
      }
      const places = await manager.find(TripPlace, { where: { tripId: locked.id } });
      const byId = new Map(places.map((p) => [p.id, p]));
      const listed = data.days.flatMap((group) => group.placeIds.map((id) => id.toLowerCase()));
      if (new Set(listed).size !== listed.length) throw invalid({ days: 'a place is listed more than once' });
      if (listed.some((id) => !byId.has(id))) throw invalid({ days: "a listed place isn't in this trip" });
      if (listed.length !== places.length) throw invalid({ days: 'every place of the trip must be listed' });

      for (const group of data.days) {
        for (const [position, id] of group.placeIds.entries()) {
          const place = byId.get(id.toLowerCase())!;
          if ((place.day ?? null) !== group.day || place.position !== position) {
            await manager.update(TripPlace, { id: place.id }, { day: group.day, position });
          }
        }
      }
      const itineraryVersion = await this.bump(manager, locked);
      const rows = await manager.find(TripPlace, { where: { tripId: locked.id } });
      return { places: rows.sort(compareTripPlaces).map(toTripPlaceDto), itineraryVersion };
    });
    await this.activity?.emit({ type: 'trip.itinerary', tripId: trip!.id, userId: user.id });
    return result;
  }

  /**
   * AI accept: appends the places in the caller's transaction (trip locked here), skipping ones
   * already in the trip or beyond the 200-place cap (`skipped`), and any past the trip owner's plan
   * limit (`skippedForPlan`).
   */
  async appendInTransaction(
    manager: EntityManager,
    tripId: string,
    userId: string,
    items: NewTripPlace[],
  ): Promise<{ added: number; skipped: number; skippedForPlan: number }> {
    const locked = await this.lockTrip(manager, tripId);
    const limit = await this.billing.tripPlacesLimit(locked.ownerUserId, manager);
    const { added, skippedForPlan } = await this.append(manager, locked, userId, limit, items);
    return { added, skipped: items.length - added - skippedForPlan, skippedForPlan };
  }

  /**
   * After a date change (in the trip update's transaction, trip locked): places on days that no
   * longer exist move to the end of Unplanned, keeping their order, and the version goes up.
   */
  async onDatesChanged(manager: EntityManager, trip: Trip): Promise<void> {
    const locked = await this.lockTrip(manager, trip.id);
    const days = tripDays(locked);
    const places = (await manager.find(TripPlace, { where: { tripId: locked.id } })).sort(compareTripPlaces);
    const moving = places.filter((p) => p.day !== null && p.day > days);
    if (moving.length === 0) return;
    let next = nextPosition(places, null);
    for (const place of moving) await manager.update(TripPlace, { id: place.id }, { day: null, position: next++ });
    await this.bump(manager, locked);
  }

  private async append(
    manager: EntityManager,
    trip: Trip,
    userId: string,
    planLimit: number,
    items: NewTripPlace[],
  ): Promise<{ added: number; ids: string[]; skippedForPlan: number }> {
    const existing = await manager.find(TripPlace, { where: { tripId: trip.id } });
    const seen = new Set(existing.map((p) => p.googlePlaceId));
    const days = tripDays(trip);
    const nextByDay = new Map<number | null, number>();
    let count = existing.length;
    const ids: string[] = [];
    let skippedForPlan = 0;
    for (const item of items) {
      if (seen.has(item.match.googlePlaceId) || count >= MAX_TRIP_PLACES) continue;
      if (count >= planLimit) {
        skippedForPlan += 1;
        continue;
      }
      seen.add(item.match.googlePlaceId);
      const day = item.day !== null && item.day >= 1 && item.day <= days ? item.day : null;
      const position = nextByDay.get(day) ?? nextPosition(existing, day);
      nextByDay.set(day, position + 1);
      const { identifiers } = await manager.insert(TripPlace, {
        tripId: trip.id,
        googlePlaceId: item.match.googlePlaceId,
        name: (item.match.name || item.match.googlePlaceId).slice(0, 200),
        category: item.category,
        day,
        position,
        startTime: item.startTime ?? null,
        notes: item.notes,
        address: item.match.address,
        lat: item.match.location.lat,
        lng: item.match.location.lng,
        rating: item.match.rating,
        mapsUrl: item.match.mapsUrl,
        types: item.match.types,
        source: item.source,
        createdBy: userId,
      });
      ids.push(String(identifiers[0].id));
      count += 1;
    }
    if (ids.length > 0) await this.bump(manager, trip);
    return { added: ids.length, ids, skippedForPlan };
  }

  /** The trip row, locked until the transaction ends. */
  private async lockTrip(manager: EntityManager, tripId: string): Promise<Trip> {
    const trip = await manager.findOne(Trip, { where: { id: tripId }, lock: LOCK });
    if (!trip) throw tripNotFound();
    return trip;
  }

  /** +1 on the locked trip's version; returns the new version. */
  private async bump(manager: EntityManager, locked: Trip): Promise<number> {
    const version = (locked.itineraryVersion ?? 0) + 1;
    await manager.update(Trip, { id: locked.id }, { itineraryVersion: version });
    locked.itineraryVersion = version;
    return version;
  }

  /** Positions 0…n-1 for places already sorted. */
  private async renumber(manager: EntityManager, sorted: TripPlace[]): Promise<void> {
    for (const [position, place] of sorted.entries()) {
      if (place.position !== position) await manager.update(TripPlace, { id: place.id }, { position });
    }
  }

  private takeSearchSlot(userId: string, now = Date.now()): void {
    const { max, windowMs } = SEARCH_RATE_LIMIT;
    const recent = (this.searches.get(userId) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      this.searches.set(userId, recent);
      const freeAt = recent[recent.length - max] + windowMs;
      throw new AppError('RATE_LIMITED', 'Too many place searches. Please wait a little.', undefined, {
        retryAfterSeconds: (freeAt - now) / 1000,
      });
    }
    recent.push(now);
    this.searches.delete(userId);
    if (this.searches.size >= MAX_TRACKED_SEARCHERS) this.searches.delete(this.searches.keys().next().value!);
    this.searches.set(userId, recent);
  }

  /** The destination's centre (Text Search on the destination), cached per trip and destination. */
  private async center(trip: Trip, locale: Locale): Promise<LatLng | null> {
    const key = `${trip.id}|${normalizeName(trip.destination)}`;
    const cached = this.centers.get(key);
    if (cached) return cached;
    const match = await this.provider.searchText({ query: trip.destination, languageCode: locale });
    if (!match) return null;
    if (this.centers.size >= MAX_CACHED_CENTERS) this.centers.delete(this.centers.keys().next().value!);
    this.centers.set(key, match.location);
    return match.location;
  }
}

/** The next free position in `day` (null = Unplanned) among `places`. */
function nextPosition(places: TripPlace[], day: number | null): number {
  return places.filter((p) => (p.day ?? null) === day).reduce((max, p) => Math.max(max, (p.position ?? 0) + 1), 0);
}
