import { createHash } from 'node:crypto';
import type { FetchFn } from '../ai/llm/http-json.js';
import { GOOGLE_PLACE_DETAILS_URL, GOOGLE_SEARCH_TEXT_URL } from '../ai/places/google-places.provider.js';

/** A photo as Google lists it on a place: its resource name, size and author credits. */
export type PhotoRef = {
  name: string;
  widthPx: number | null;
  heightPx: number | null;
  attributions: { displayName: string; uri: string | null }[];
};

/** A destination as Places resolves it, for the explorer achievements. */
export type ResolvedDestination = { placeId: string; countryCode: string | null };

/**
 * Where photos come from: Google Places (New) or the offline mock. `cityPhotos`/`placePhotos` list
 * photo refs (throw on a failed lookup); `photoUri` turns one into a public image URL without the key.
 */
export interface PhotoSource {
  readonly name: 'google' | 'mock';
  cityPhotos(query: string): Promise<PhotoRef[]>;
  placePhotos(googlePlaceId: string): Promise<PhotoRef[]>;
  /** The image URL at `maxWidthPx`, or null if Google has none. Never contains the API key. */
  photoUri(ref: PhotoRef, maxWidthPx: number): Promise<string | null>;
  /** The destination's place id and country (ISO 3166-1 alpha-2), or null if nothing matches. */
  resolveDestination(query: string): Promise<ResolvedDestination | null>;
}

export const PHOTO_SOURCE = Symbol('PHOTO_SOURCE');
/** The fetch the Google source uses (tests override it). */
export const MEDIA_FETCH = Symbol('MEDIA_FETCH');

/** Text Search for city photos: only the id and photos (the field mask decides billing). */
export const CITY_PHOTOS_FIELD_MASK = 'places.id,places.photos';
/** Place Details for a place's photos. */
export const PLACE_PHOTOS_FIELD_MASK = 'photos';
/** Text Search for a destination's country. */
export const DESTINATION_FIELD_MASK = 'places.id,places.addressComponents';

const TIMEOUT_MS = 10_000;
const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/;
// `places/<place id>/photos/<photo reference>`
const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,300}\/photos\/[A-Za-z0-9_-]{1,1000}$/;

type GooglePhoto = {
  name?: string;
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: { displayName?: string; uri?: string }[];
};

function toRefs(photos: GooglePhoto[] | undefined): PhotoRef[] {
  return (photos ?? [])
    .filter((p): p is GooglePhoto & { name: string } => typeof p.name === 'string' && PHOTO_NAME.test(p.name))
    .map((p) => ({
      name: p.name,
      widthPx: typeof p.widthPx === 'number' ? p.widthPx : null,
      heightPx: typeof p.heightPx === 'number' ? p.heightPx : null,
      attributions: (p.authorAttributions ?? [])
        .filter((a) => typeof a.displayName === 'string' && a.displayName)
        .map((a) => ({ displayName: a.displayName!, uri: typeof a.uri === 'string' && /^https:\/\//.test(a.uri) ? a.uri : null })),
    }));
}

/** Google Places (New) over plain fetch. Errors carry the HTTP status only (bodies can echo the request). */
export class GooglePhotoSource implements PhotoSource {
  readonly name = 'google' as const;

  constructor(
    private readonly apiKey: string,
    private readonly fetchFn: FetchFn = (...args) => fetch(...args),
  ) {}

  async cityPhotos(query: string): Promise<PhotoRef[]> {
    const result = (await this.searchText(query, CITY_PHOTOS_FIELD_MASK)) as { places?: { photos?: GooglePhoto[] }[] };
    return toRefs(result.places?.[0]?.photos);
  }

  async placePhotos(googlePlaceId: string): Promise<PhotoRef[]> {
    if (!PLACE_ID.test(googlePlaceId)) return [];
    const response = await this.fetchFn(`${GOOGLE_PLACE_DETAILS_URL}/${encodeURIComponent(googlePlaceId)}`, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': PLACE_PHOTOS_FIELD_MASK },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404 || response.status === 400) return [];
    if (!response.ok) throw new Error(`Place photos failed: HTTP ${response.status}`);
    return toRefs(((await response.json()) as { photos?: GooglePhoto[] }).photos);
  }

  async photoUri(ref: PhotoRef, maxWidthPx: number): Promise<string | null> {
    if (!PHOTO_NAME.test(ref.name)) return null;
    // skipHttpRedirect: Google answers with JSON { name, photoUri } instead of redirecting to the image,
    // so the key (sent as a header, never in the URL) stays on the server.
    const url = `https://places.googleapis.com/v1/${ref.name}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`;
    const response = await this.fetchFn(url, {
      method: 'GET',
      headers: { 'X-Goog-Api-Key': this.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Place photo failed: HTTP ${response.status}`);
    const { photoUri } = (await response.json()) as { photoUri?: unknown };
    if (typeof photoUri !== 'string' || !/^https:\/\//.test(photoUri)) return null;
    // Belt and braces: never hand out anything carrying the key.
    if (photoUri.includes(this.apiKey) || /[?&]key=/i.test(photoUri)) return null;
    return photoUri;
  }

  async resolveDestination(query: string): Promise<ResolvedDestination | null> {
    const result = (await this.searchText(query, DESTINATION_FIELD_MASK)) as {
      places?: { id?: string; addressComponents?: { shortText?: string; types?: string[] }[] }[];
    };
    const place = result.places?.[0];
    if (!place?.id) return null;
    const country = place.addressComponents?.find((c) => c.types?.includes('country'))?.shortText;
    return { placeId: place.id, countryCode: country && /^[A-Za-z]{2}$/.test(country) ? country.toUpperCase() : null };
  }

  private async searchText(query: string, fieldMask: string): Promise<unknown> {
    const response = await this.fetchFn(GOOGLE_SEARCH_TEXT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify({ textQuery: query, pageSize: 1 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Places search failed: HTTP ${response.status}`);
    return response.json();
  }
}

/** Lowercase, accents folded, anything else to `-`: a stable id for a destination text. */
export const destinationSlug = (query: string) =>
  query
    .split(',')[0]
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'city';

/** Known mock cities' countries; anything else gets a stable country from its name. */
const MOCK_COUNTRIES: Record<string, string> = {
  lisbon: 'PT', lisboa: 'PT', porto: 'PT', madrid: 'ES', barcelona: 'ES', paris: 'FR', rome: 'IT', roma: 'IT',
  london: 'GB', berlin: 'DE', amsterdam: 'NL', tokyo: 'JP', 'new-york': 'US', 'rio-de-janeiro': 'BR',
  'sao-paulo': 'BR', 'buenos-aires': 'AR', 'mexico-city': 'MX', 'cidade-do-mexico': 'MX', lima: 'PE',
  santiago: 'CL', bogota: 'CO', athens: 'GR', istanbul: 'TR', cairo: 'EG', sydney: 'AU', auckland: 'NZ',
};
const MOCK_FALLBACK_COUNTRIES = ['IS', 'NO', 'SE', 'FI', 'DK', 'IE', 'BE', 'CH', 'AT', 'CZ', 'PL', 'HR', 'MA', 'ZA', 'IN', 'TH', 'VN', 'KR', 'CA', 'UY'];

/** Ids starting with this have no photos (tests and dev). */
export const MOCK_NO_PHOTOS_PREFIX = 'mock-missing-';

/**
 * Offline and deterministic: every city and place has photos at
 * `https://picsum.photos/seed/<id>-<i>/<w>/<h>` (3:2) with a mock credit; destinations resolve to
 * `mock-city-<slug>` in a country from a small table (or one derived from the name).
 */
export class MockPhotoSource implements PhotoSource {
  readonly name = 'mock' as const;

  async cityPhotos(query: string): Promise<PhotoRef[]> {
    return this.refs(`city-${destinationSlug(query)}`, 6);
  }

  async placePhotos(googlePlaceId: string): Promise<PhotoRef[]> {
    if (googlePlaceId.startsWith(MOCK_NO_PHOTOS_PREFIX) || !PLACE_ID.test(googlePlaceId)) return [];
    return this.refs(googlePlaceId, 5);
  }

  async photoUri(ref: PhotoRef, maxWidthPx: number): Promise<string> {
    return `https://picsum.photos/seed/${ref.name}/${maxWidthPx}/${Math.round((maxWidthPx * 2) / 3)}`;
  }

  async resolveDestination(query: string): Promise<ResolvedDestination> {
    const slug = destinationSlug(query);
    const digest = createHash('sha256').update(slug).digest();
    return { placeId: `mock-city-${slug}`, countryCode: MOCK_COUNTRIES[slug] ?? MOCK_FALLBACK_COUNTRIES[digest[0] % MOCK_FALLBACK_COUNTRIES.length] };
  }

  private refs(id: string, count: number): PhotoRef[] {
    return Array.from({ length: count }, (_, i) => ({
      // The mock "resource name" is the picsum seed.
      name: `${id}-${i}`,
      widthPx: 4800,
      heightPx: 3200,
      attributions: [{ displayName: 'Mock photographer', uri: 'https://picsum.photos' }],
    }));
  }
}
