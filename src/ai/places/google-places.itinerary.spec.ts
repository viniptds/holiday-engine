import { jest } from '@jest/globals';
import {
  GOOGLE_DETAILS_FIELD_MASK,
  GOOGLE_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_URL,
  GOOGLE_SEARCH_TEXT_URL,
  GooglePlacesProvider,
} from './google-places.provider.js';
import type { FetchFn } from '../llm/http-json.js';

// The itinerary's Google calls (docs/app-itinerary-spec.md): Text Search for several results and
// Place Details by id, both over mocked fetch.

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const place = (id: string) => ({
  id,
  displayName: { text: `Place ${id}` },
  formattedAddress: `Street ${id}`,
  location: { latitude: 38.7, longitude: -9.1 },
  rating: 4.1,
  types: ['restaurant', 'food'],
  googleMapsUri: `https://maps.google.com/?cid=${id}`,
});

function provider(...responses: Response[]) {
  const fetch = jest.fn<FetchFn>(async () => responses.shift()!);
  return { instance: new GooglePlacesProvider('places-key', fetch), fetch };
}

describe('GooglePlacesProvider for the itinerary', () => {
  it('searches several places with a type hint, the page size and the location bias', async () => {
    const { instance, fetch } = provider(json(200, { places: [place('a'), { id: 'no-location' }, place('b')] }));

    const results = await instance.searchMany({
      query: 'pastéis',
      languageCode: 'pt-BR',
      limit: 10,
      includedType: 'restaurant',
      near: { center: { lat: 38.72, lng: -9.14 }, radiusMeters: 50_000 },
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(GOOGLE_SEARCH_TEXT_URL);
    expect(init!.headers).toMatchObject({ 'X-Goog-FieldMask': GOOGLE_FIELD_MASK });
    expect(JSON.parse(String(init!.body))).toEqual({
      textQuery: 'pastéis',
      languageCode: 'pt-BR',
      pageSize: 10,
      includedType: 'restaurant',
      locationBias: { circle: { center: { latitude: 38.72, longitude: -9.14 }, radius: 50_000 } },
    });
    // A result without a location is dropped.
    expect(results.map((r) => r.googlePlaceId)).toEqual(['a', 'b']);
    expect(results[0]).toEqual({
      googlePlaceId: 'a',
      name: 'Place a',
      address: 'Street a',
      location: { lat: 38.7, lng: -9.1 },
      rating: 4.1,
      types: ['restaurant', 'food'],
      mapsUrl: 'https://maps.google.com/?cid=a',
    });
  });

  it('sends no includedType without a hint, and fails on an error status (status only)', async () => {
    const { instance, fetch } = provider(json(200, {}), json(500, { error: { message: 'echo places-key' } }));

    expect(await instance.searchMany({ query: 'x', languageCode: 'en', limit: 10 })).toEqual([]);
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).not.toHaveProperty('includedType');
    await expect(instance.searchMany({ query: 'x', languageCode: 'en', limit: 10 })).rejects.toThrow('Places search failed: HTTP 500');
  });

  it('gets Place Details by id with the minimal field mask and the language', async () => {
    const { instance, fetch } = provider(json(200, place('ChIJ_abc-1')));

    const match = await instance.details('ChIJ_abc-1', 'es');

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(`${GOOGLE_PLACE_DETAILS_URL}/ChIJ_abc-1?languageCode=es`);
    expect(init!.method).toBe('GET');
    expect(init!.headers).toEqual({ 'X-Goog-Api-Key': 'places-key', 'X-Goog-FieldMask': GOOGLE_DETAILS_FIELD_MASK });
    expect(GOOGLE_DETAILS_FIELD_MASK).toBe('id,displayName,formattedAddress,location,rating,types,googleMapsUri');
    expect(match).toMatchObject({ googlePlaceId: 'ChIJ_abc-1', name: 'Place ChIJ_abc-1', location: { lat: 38.7, lng: -9.1 } });
  });

  it('treats 404 and 400 as "no such place", and fails on other errors', async () => {
    const { instance } = provider(json(404, {}), json(400, {}), json(503, {}));

    expect(await instance.details('ChIJ_missing', 'en')).toBeNull();
    expect(await instance.details('ChIJ_bad', 'en')).toBeNull();
    await expect(instance.details('ChIJ_x', 'en')).rejects.toThrow('Place details failed: HTTP 503');
  });

  it('never sends an id that could change the URL', async () => {
    const { instance, fetch } = provider();

    for (const id of ['../places:searchText', 'a/b', 'a?b', 'x'.repeat(301), '']) {
      expect(await instance.details(id, 'en')).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
