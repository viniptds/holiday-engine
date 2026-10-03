import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { distanceKm, mapLimit, PlacesVerifier } from './places-verifier.js';
import type { PlaceMatch, PlaceSearch, PlacesProvider } from './places-provider.js';
import type { DraftPlace, TripDraft } from '../ai.types.js';

const LISBON = { lat: 38.7223, lng: -9.1393 };

const match = (id: string, location = { lat: 38.71, lng: -9.14 }): PlaceMatch => ({
  googlePlaceId: id,
  name: id,
  address: `${id} address`,
  location,
  rating: 4.2,
  types: ['tourist_attraction'],
  mapsUrl: `https://maps.example/${id}`,
});

const place = (name: string): DraftPlace => ({ name, category: 'sight', day: null, why: 'Nice', verified: false, place: null });

const draft = (names: string[], destination: string | null = 'Lisbon'): TripDraft => ({
  ready: true,
  destination,
  startDate: '2026-11-10',
  endDate: '2026-11-12',
  partyType: null,
  partySize: null,
  story: null,
  places: names.map(place),
  questions: [],
});

/** Answers the destination with LISBON and places from `results` (by name, before the comma). */
function stubProvider(results: Record<string, PlaceMatch | null | Error> = {}) {
  const searchText = jest.fn(async (search: PlaceSearch): Promise<PlaceMatch | null> => {
    if (!search.near) return match('lisbon', LISBON);
    const result = results[search.query.split(',')[0]];
    if (result instanceof Error) throw result;
    return result === undefined ? match(`id-${search.query.split(',')[0]}`) : result;
  });
  const provider: PlacesProvider = { name: 'mock', searchText };
  return { verifier: new PlacesVerifier(provider), searchText };
}

describe('PlacesVerifier', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('verifies places near the destination centre, biased to a 50 km circle', async () => {
    const { verifier, searchText } = stubProvider();

    const [result] = await verifier.verify('c1', 'es', draft(['Belem Tower']), null);

    expect(result).toEqual({
      ...place('Belem Tower'),
      verified: true,
      place: {
        googlePlaceId: 'id-Belem Tower',
        address: 'id-Belem Tower address',
        lat: 38.71,
        lng: -9.14,
        rating: 4.2,
        types: ['tourist_attraction'],
        mapsUrl: 'https://maps.example/id-Belem Tower',
      },
    });
    expect(searchText).toHaveBeenCalledWith({ query: 'Lisbon', languageCode: 'es' });
    expect(searchText).toHaveBeenCalledWith({
      query: 'Belem Tower, Lisbon',
      languageCode: 'es',
      near: { center: LISBON, radiusMeters: 50_000 },
    });
  });

  it('rejects a match more than 50 km away, and a missing match', async () => {
    const { verifier } = stubProvider({ Faraway: match('far', { lat: 41.15, lng: -8.61 }), Nowhere: null });
    const result = await verifier.verify('c1', 'en', draft(['Faraway', 'Nowhere']), null);
    expect(result.map((p) => [p.verified, p.place])).toEqual([
      [false, null],
      [false, null],
    ]);
  });

  it('leaves a place unverified when its lookup fails, without failing the others', async () => {
    const { verifier } = stubProvider({ Broken: new Error('HTTP 500') });
    const result = await verifier.verify('c1', 'en', draft(['Broken', 'Fine']), null);
    expect(result.map((p) => p.verified)).toEqual([false, true]);
  });

  it('returns everything unverified when the destination lookup fails or there is no destination', async () => {
    const failing: PlacesProvider = { name: 'mock', searchText: async () => Promise.reject(new Error('down')) };
    expect((await new PlacesVerifier(failing).verify('c1', 'en', draft(['A']), null)).map((p) => p.verified)).toEqual([false]);

    const { verifier, searchText } = stubProvider();
    expect((await verifier.verify('c1', 'en', draft(['A'], null), null))[0].verified).toBe(false);
    expect(searchText).not.toHaveBeenCalled();
  });

  it('caches the centre per conversation and destination', async () => {
    const { verifier, searchText } = stubProvider();
    await verifier.verify('c1', 'en', draft(['A']), null);
    await verifier.verify('c1', 'en', draft(['B']), null);
    await verifier.verify('c2', 'en', draft(['C']), null);

    const centreLookups = searchText.mock.calls.filter(([search]) => !search.near);
    expect(centreLookups).toHaveLength(2);
  });

  it('reuses places verified in the previous draft of the same destination', async () => {
    const { verifier, searchText } = stubProvider();
    const previous = draft(['Belem Tower']);
    previous.places = await verifier.verify('c1', 'en', previous, null);
    searchText.mockClear();

    const result = await verifier.verify('c1', 'en', draft(['belém tower', 'Alfama']), previous);

    expect(result[0]).toMatchObject({ name: 'belém tower', verified: true, place: { googlePlaceId: 'id-Belem Tower' } });
    expect(searchText.mock.calls.map(([s]) => s.query)).toEqual(['Alfama, Lisbon']);
  });

  it('looks places up again when the destination changed', async () => {
    const { verifier, searchText } = stubProvider();
    const previous = draft(['Old Town']);
    previous.places = await verifier.verify('c1', 'en', previous, null);
    searchText.mockClear();

    await verifier.verify('c1', 'en', draft(['Old Town'], 'Porto'), previous);
    expect(searchText.mock.calls.map(([s]) => s.query)).toEqual(['Porto', 'Old Town, Porto']);
  });
});

describe('distanceKm', () => {
  it('measures great-circle distance', () => {
    expect(distanceKm(LISBON, { lat: 41.1579, lng: -8.6291 })).toBeCloseTo(274, -1);
    expect(distanceKm(LISBON, LISBON)).toBe(0);
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async (n) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(peak).toBe(4);
  });
});
