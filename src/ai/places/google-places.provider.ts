import type { FetchFn } from '../llm/http-json.js';
import type { PlaceListSearch, PlaceMatch, PlaceSearch, PlacesDirectory } from './places-provider.js';

export const GOOGLE_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';
/** Place Details (New): `${GOOGLE_PLACE_DETAILS_URL}/<place id>`. */
export const GOOGLE_PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places';

/** The field mask decides billing: request these fields and nothing else. */
export const GOOGLE_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.googleMapsUri';

/** The same fields for Place Details, where they're top level (no `places.` prefix). */
export const GOOGLE_DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,location,rating,types,googleMapsUri';

const TIMEOUT_MS = 10_000;
/** Google place ids are URL-safe base64-like strings; anything else is refused before any request. */
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  types?: string[];
  googleMapsUri?: string;
};

function toMatch(place: GooglePlace | undefined): PlaceMatch | null {
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!place?.id || typeof lat !== 'number' || typeof lng !== 'number') return null;
  return {
    googlePlaceId: place.id,
    name: place.displayName?.text ?? '',
    address: place.formattedAddress ?? '',
    location: { lat, lng },
    rating: typeof place.rating === 'number' ? place.rating : null,
    types: Array.isArray(place.types) ? place.types.filter((t) => typeof t === 'string') : [],
    mapsUrl: place.googleMapsUri ?? null,
  };
}

/** Google Places API (New) Text Search and Place Details over plain `fetch`. */
export class GooglePlacesProvider implements PlacesDirectory {
  readonly name = 'google' as const;
  private readonly fetch: FetchFn;

  constructor(
    private readonly apiKey: string,
    fetchFn?: FetchFn,
  ) {
    this.fetch = fetchFn ?? ((...args) => fetch(...args));
  }

  buildBody(search: PlaceSearch, pageSize = 1, includedType?: string) {
    return {
      textQuery: search.query,
      languageCode: search.languageCode,
      pageSize,
      ...(includedType ? { includedType } : {}),
      ...(search.near
        ? {
            locationBias: {
              circle: {
                center: { latitude: search.near.center.lat, longitude: search.near.center.lng },
                radius: search.near.radiusMeters,
              },
            },
          }
        : {}),
    };
  }

  async searchText(search: PlaceSearch): Promise<PlaceMatch | null> {
    return (await this.search(this.buildBody(search)))[0] ?? null;
  }

  async searchMany(search: PlaceListSearch): Promise<PlaceMatch[]> {
    return this.search(this.buildBody(search, search.limit, search.includedType));
  }

  async details(googlePlaceId: string, languageCode: string): Promise<PlaceMatch | null> {
    if (!PLACE_ID.test(googlePlaceId)) return null;
    const url = `${GOOGLE_PLACE_DETAILS_URL}/${encodeURIComponent(googlePlaceId)}?languageCode=${encodeURIComponent(languageCode)}`;
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': GOOGLE_DETAILS_FIELD_MASK },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // 404 (unknown id) and 400 (malformed id) both mean "no such place".
    if (response.status === 404 || response.status === 400) return null;
    if (!response.ok) throw new Error(`Place details failed: HTTP ${response.status}`);
    return toMatch((await response.json()) as GooglePlace);
  }

  private async search(body: ReturnType<GooglePlacesProvider['buildBody']>): Promise<PlaceMatch[]> {
    const response = await this.fetch(GOOGLE_SEARCH_TEXT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': GOOGLE_FIELD_MASK,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The status only: Google error bodies can echo the request.
    if (!response.ok) throw new Error(`Places search failed: HTTP ${response.status}`);
    const result = (await response.json()) as { places?: GooglePlace[] };
    return (result.places ?? []).map(toMatch).filter((m): m is PlaceMatch => m !== null);
  }
}
