import type { FetchFn } from '../llm/http-json.js';
import type { PlaceMatch, PlaceSearch, PlacesProvider } from './places-provider.js';

export const GOOGLE_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

/** The field mask decides billing: request these fields and nothing else. */
export const GOOGLE_FIELD_MASK =
  'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.googleMapsUri';

const TIMEOUT_MS = 10_000;

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  rating?: number;
  types?: string[];
  googleMapsUri?: string;
};

/** Google Places API (New) Text Search over plain `fetch`. */
export class GooglePlacesProvider implements PlacesProvider {
  readonly name = 'google' as const;
  private readonly fetch: FetchFn;

  constructor(
    private readonly apiKey: string,
    fetchFn?: FetchFn,
  ) {
    this.fetch = fetchFn ?? ((...args) => fetch(...args));
  }

  buildBody(search: PlaceSearch) {
    return {
      textQuery: search.query,
      languageCode: search.languageCode,
      pageSize: 1,
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
    const response = await this.fetch(GOOGLE_SEARCH_TEXT_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': GOOGLE_FIELD_MASK,
      },
      body: JSON.stringify(this.buildBody(search)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The status only: Google error bodies can echo the request.
    if (!response.ok) throw new Error(`Places search failed: HTTP ${response.status}`);
    const body = (await response.json()) as { places?: GooglePlace[] };
    const place = body.places?.[0];
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
}
