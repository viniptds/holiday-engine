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

export const PLACES_PROVIDER = Symbol('PLACES_PROVIDER');
