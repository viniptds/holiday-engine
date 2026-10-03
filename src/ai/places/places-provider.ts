export type LatLng = { lat: number; lng: number };

export type PlaceMatch = {
  googlePlaceId: string;
  name: string;
  address: string;
  location: LatLng;
  rating: number | null;
  types: string[];
  mapsUrl: string | null;
};

export type PlaceSearch = {
  query: string;
  /** Google `languageCode` (`en`, `pt-BR`, `es`). */
  languageCode: string;
  /** Bias results to a circle around this point. */
  near?: { center: LatLng; radiusMeters: number };
};

/** Text search for one place. Returns the best match or null; throws on a failed lookup. */
export interface PlacesProvider {
  readonly name: 'google' | 'mock';
  searchText(search: PlaceSearch): Promise<PlaceMatch | null>;
}

/** A Text Search for several places (the place search endpoint). */
export type PlaceListSearch = PlaceSearch & {
  /** At most this many results (Google `pageSize`). */
  limit: number;
  /** Google `includedType` hint (e.g. `restaurant`); not strict. */
  includedType?: string;
};

/**
 * Everything the itinerary needs from the places provider: Text Search for several results, and
 * Place Details by id (to re-check a place before it's added). Both providers implement it.
 */
export interface PlacesDirectory extends PlacesProvider {
  searchMany(search: PlaceListSearch): Promise<PlaceMatch[]>;
  /** The place with this id, or null if Google doesn't know it; throws on a failed lookup. */
  details(googlePlaceId: string, languageCode: string): Promise<PlaceMatch | null>;
}

export const PLACES_PROVIDER = Symbol('PLACES_PROVIDER');
