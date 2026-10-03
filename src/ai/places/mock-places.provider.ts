import { createHash } from 'node:crypto';
import type { PlaceListSearch, PlaceMatch, PlaceSearch, PlacesDirectory } from './places-provider.js';

/** Where every mock destination is (Lisbon). */
export const MOCK_CENTER = { lat: 38.7223, lng: -9.1393 };

/** Mock Place Details ids with these prefixes are about 300 km away, or unknown. */
export const MOCK_FAR_PREFIX = 'mock-far-';
export const MOCK_MISSING_PREFIX = 'mock-missing-';

// A few keywords give mock places realistic Google types, so category derivation shows up in dev.
const KEYWORD_TYPES: [RegExp, string[]][] = [
  [/restaurant|caf[eé]|bakery|food|tasca|pastel/i, ['restaurant', 'food', 'point_of_interest']],
  [/museum|museu|museo|monument|tower|torre|castle|castelo/i, ['museum', 'tourist_attraction', 'point_of_interest']],
  [/park|parque|garden|jardim|beach|praia/i, ['park', 'point_of_interest']],
  [/bar\b|club|pub/i, ['bar', 'point_of_interest']],
  [/market|mercado|shop|store|mall/i, ['market', 'point_of_interest']],
  [/hotel|hostel/i, ['lodging', 'point_of_interest']],
];

const typesFor = (name: string) => KEYWORD_TYPES.find(([pattern]) => pattern.test(name))?.[1] ?? ['point_of_interest'];

/**
 * Deterministic offline stand-in for tests and dev: every query matches, a few kilometres from
 * MOCK_CENTER, with an id derived from the query. Places it returned can be looked up again by id.
 */
export class MockPlacesProvider implements PlacesDirectory {
  readonly name = 'mock' as const;
  private readonly known = new Map<string, PlaceMatch>();

  async searchText(search: PlaceSearch): Promise<PlaceMatch | null> {
    return this.place(search.query);
  }

  async searchMany(search: PlaceListSearch): Promise<PlaceMatch[]> {
    const count = Math.min(search.limit, 5);
    return Array.from({ length: count }, (_, i) => this.place(i === 0 ? search.query : `${search.query} ${i + 1}`));
  }

  async details(googlePlaceId: string): Promise<PlaceMatch | null> {
    if (googlePlaceId.startsWith(MOCK_MISSING_PREFIX)) return null;
    const known = this.known.get(googlePlaceId);
    if (known) return known;
    const far = googlePlaceId.startsWith(MOCK_FAR_PREFIX);
    const name = `Place ${googlePlaceId.slice(-6)}`;
    return {
      googlePlaceId,
      name,
      address: `${name}, Mock City`,
      // About 300 km north for the "far" ids.
      location: far ? { lat: MOCK_CENTER.lat + 2.7, lng: MOCK_CENTER.lng } : { ...MOCK_CENTER },
      rating: 4.2,
      types: ['point_of_interest'],
      mapsUrl: null,
    };
  }

  private place(query: string): PlaceMatch {
    const digest = createHash('sha256').update(query.toLowerCase()).digest();
    // Up to ±0.05° (about 5 km) from the centre.
    const offset = (byte: number) => ((byte - 128) / 128) * 0.05;
    const name = query.split(',')[0].trim();
    const match: PlaceMatch = {
      googlePlaceId: `mock-${digest.subarray(0, 8).toString('hex')}`,
      name,
      address: `${name}, Mock City`,
      location: { lat: MOCK_CENTER.lat + offset(digest[8]), lng: MOCK_CENTER.lng + offset(digest[9]) },
      rating: Math.round((3.5 + (digest[10] / 255) * 1.5) * 10) / 10,
      types: typesFor(name),
      mapsUrl: null,
    };
    if (this.known.size >= 10_000) this.known.delete(this.known.keys().next().value!);
    this.known.set(match.googlePlaceId, match);
    return match;
  }
}
