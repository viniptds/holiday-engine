import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Locale } from '../../app-common/locale.js';
import { MAX_DRAFT_PLACES } from '../ai.types.js';
import type { DraftPlace, TripDraft } from '../ai.types.js';
import { normalizeName } from '../draft.js';
import { PLACES_PROVIDER } from './places-provider.js';
import type { LatLng, PlaceMatch, PlacesProvider } from './places-provider.js';

/** A place further than this from the destination centre doesn't count as a match. */
export const MAX_DISTANCE_KM = 50;
const LOOKUP_CONCURRENCY = 4;
const MAX_CACHED_CENTERS = 1000;

/** Great-circle distance in km. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Runs `work` over `items` with at most `limit` in flight, keeping the order of results. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

const unverified = (place: DraftPlace): DraftPlace => ({ ...place, verified: false, place: null });

/**
 * Checks draft places against the places provider. The destination centre is looked up once per
 * conversation and destination; a place is verified only within 50 km of it. Places verified in the
 * previous draft (same destination) are reused without a lookup. Lookup failures never fail the
 * turn: those places just come back unverified.
 */
@Injectable()
export class PlacesVerifier {
  private readonly logger = new Logger(PlacesVerifier.name);
  /** `${conversationId}|${destination key}` → centre. Insertion-ordered, so the oldest is evicted first. */
  private readonly centers = new Map<string, LatLng>();

  constructor(@Inject(PLACES_PROVIDER) private readonly places: PlacesProvider) {}

  async verify(conversationId: string, locale: Locale, draft: TripDraft, previous: TripDraft | null): Promise<DraftPlace[]> {
    const places = draft.places.slice(0, MAX_DRAFT_PLACES);
    if (!draft.destination || places.length === 0) return places.map(unverified);
    const destinationKey = normalizeName(draft.destination);

    const known = new Map<string, DraftPlace>();
    if (previous?.destination && normalizeName(previous.destination) === destinationKey) {
      for (const place of previous.places) if (place.verified) known.set(normalizeName(place.name), place);
    }

    let center: LatLng | null;
    try {
      center = await this.center(conversationId, destinationKey, draft.destination, locale);
    } catch (error) {
      this.logger.warn(`Places: destination lookup failed for conversation ${conversationId}: ${(error as Error).message}`);
      return places.map(unverified);
    }
    if (!center) return places.map(unverified);

    let failures = 0;
    const result = await mapLimit(places, LOOKUP_CONCURRENCY, async (place) => {
      const cached = known.get(normalizeName(place.name));
      if (cached) return { ...place, verified: true, place: cached.place };
      try {
        const match = await this.places.searchText({
          query: `${place.name}, ${draft.destination}`,
          languageCode: locale,
          near: { center, radiusMeters: MAX_DISTANCE_KM * 1000 },
        });
        return match && distanceKm(center, match.location) <= MAX_DISTANCE_KM ? this.verified(place, match) : unverified(place);
      } catch {
        failures += 1;
        return unverified(place);
      }
    });
    if (failures > 0) this.logger.warn(`Places: ${failures} lookup(s) failed for conversation ${conversationId}`);
    return result;
  }

  private verified(place: DraftPlace, match: PlaceMatch): DraftPlace {
    return {
      ...place,
      verified: true,
      place: {
        googlePlaceId: match.googlePlaceId,
        address: match.address,
        lat: match.location.lat,
        lng: match.location.lng,
        rating: match.rating,
        types: match.types,
        mapsUrl: match.mapsUrl,
      },
    };
  }

  private async center(conversationId: string, destinationKey: string, destination: string, locale: Locale): Promise<LatLng | null> {
    const key = `${conversationId}|${destinationKey}`;
    const cached = this.centers.get(key);
    if (cached) return cached;
    const match = await this.places.searchText({ query: destination, languageCode: locale });
    if (!match) return null;
    if (this.centers.size >= MAX_CACHED_CENTERS) this.centers.delete(this.centers.keys().next().value!);
    this.centers.set(key, match.location);
    return match.location;
  }
}
