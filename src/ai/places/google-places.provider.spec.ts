import { jest } from '@jest/globals';
import { GOOGLE_FIELD_MASK, GOOGLE_SEARCH_TEXT_URL, GooglePlacesProvider } from './google-places.provider.js';
import type { FetchFn } from '../llm/http-json.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const PLACE = {
  id: 'ChIJ123',
  displayName: { text: 'Time Out Market Lisboa', languageCode: 'pt' },
  formattedAddress: 'Av. 24 de Julho 49, 1200-479 Lisboa, Portugal',
  location: { latitude: 38.7069, longitude: -9.1459 },
  rating: 4.5,
  types: ['food_court', 'point_of_interest'],
  googleMapsUri: 'https://maps.google.com/?cid=1',
};

function provider(response: Response) {
  const fetch = jest.fn<FetchFn>(async () => response);
  return { instance: new GooglePlacesProvider('places-key', fetch), fetch };
}

describe('GooglePlacesProvider', () => {
  it('posts a Text Search with the key, the minimal field mask and a location bias', async () => {
    const { instance, fetch } = provider(json(200, { places: [PLACE] }));

    await instance.searchText({
      query: 'Time Out Market, Lisbon',
      languageCode: 'pt-BR',
      near: { center: { lat: 38.72, lng: -9.14 }, radiusMeters: 50_000 },
    });

    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(GOOGLE_SEARCH_TEXT_URL);
    expect(init!.method).toBe('POST');
    expect(init!.headers).toEqual({ 'content-type': 'application/json', 'X-Goog-Api-Key': 'places-key', 'X-Goog-FieldMask': GOOGLE_FIELD_MASK });
    expect(GOOGLE_FIELD_MASK).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.types,places.googleMapsUri',
    );
    expect(JSON.parse(String(init!.body))).toEqual({
      textQuery: 'Time Out Market, Lisbon',
      languageCode: 'pt-BR',
      pageSize: 1,
      locationBias: { circle: { center: { latitude: 38.72, longitude: -9.14 }, radius: 50_000 } },
    });
  });

  it('omits the bias when there is no centre', async () => {
    const { instance, fetch } = provider(json(200, { places: [PLACE] }));
    await instance.searchText({ query: 'Lisbon', languageCode: 'en' });
    expect(JSON.parse(String(fetch.mock.calls[0][1]!.body))).toEqual({ textQuery: 'Lisbon', languageCode: 'en', pageSize: 1 });
  });

  it('maps the first result', async () => {
    const { instance } = provider(json(200, { places: [PLACE] }));
    await expect(instance.searchText({ query: 'x', languageCode: 'en' })).resolves.toEqual({
      googlePlaceId: 'ChIJ123',
      name: 'Time Out Market Lisboa',
      address: 'Av. 24 de Julho 49, 1200-479 Lisboa, Portugal',
      location: { lat: 38.7069, lng: -9.1459 },
      rating: 4.5,
      types: ['food_court', 'point_of_interest'],
      mapsUrl: 'https://maps.google.com/?cid=1',
    });
  });

  it('returns null without a usable result', async () => {
    await expect(provider(json(200, {})).instance.searchText({ query: 'x', languageCode: 'en' })).resolves.toBeNull();
    await expect(
      provider(json(200, { places: [{ id: 'a', displayName: { text: 'No location' } }] })).instance.searchText({ query: 'x', languageCode: 'en' }),
    ).resolves.toBeNull();
  });

  it('throws on an HTTP error, naming only the status', async () => {
    const { instance } = provider(json(403, { error: { message: 'API key places-key is invalid' } }));
    await expect(instance.searchText({ query: 'x', languageCode: 'en' })).rejects.toThrow(/^Places search failed: HTTP 403$/);
  });
});
