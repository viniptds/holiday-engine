import { createHash } from 'node:crypto';
import type { PlaceMatch, PlaceSearch, PlacesProvider } from './places-provider.js';

/** Where every mock destination is (Lisbon). */
export const MOCK_CENTER = { lat: 38.7223, lng: -9.1393 };

/**
 * Deterministic offline stand-in for tests and dev: every query matches, a few kilometres from
 * MOCK_CENTER, with an id derived from the query.
 */
export class MockPlacesProvider implements PlacesProvider {
  readonly name = 'mock' as const;

  async searchText(search: PlaceSearch): Promise<PlaceMatch | null> {
    const digest = createHash('sha256').update(search.query.toLowerCase()).digest();
    // Up to ±0.05° (about 5 km) from the centre.
    const offset = (byte: number) => ((byte - 128) / 128) * 0.05;
    const name = search.query.split(',')[0].trim();
    return {
      googlePlaceId: `mock-${digest.subarray(0, 8).toString('hex')}`,
      name,
      address: `${name}, Mock City`,
      location: { lat: MOCK_CENTER.lat + offset(digest[8]), lng: MOCK_CENTER.lng + offset(digest[9]) },
      rating: Math.round((3.5 + (digest[10] / 255) * 1.5) * 10) / 10,
      types: ['point_of_interest'],
      mapsUrl: null,
    };
  }
}
