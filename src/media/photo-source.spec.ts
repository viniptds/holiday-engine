import { jest } from '@jest/globals';
import { GooglePhotoSource, MockPhotoSource, destinationSlug } from './photo-source.js';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('GooglePhotoSource.resolveDestination', () => {
  it('asks for the id and address components only, and reads the country', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      json(200, { places: [{ id: 'ChIJ-lisbon', addressComponents: [{ shortText: 'Lisboa', types: ['locality'] }, { shortText: 'pt', types: ['country', 'political'] }] }] }),
    );
    const source = new GooglePhotoSource('key-123', fetchFn as typeof fetch);

    expect(await source.resolveDestination('Lisbon')).toEqual({ placeId: 'ChIJ-lisbon', countryCode: 'PT' });
    expect(fetchFn.mock.calls[0][1]?.headers).toMatchObject({ 'X-Goog-FieldMask': 'places.id,places.addressComponents', 'X-Goog-Api-Key': 'key-123' });
  });

  it('gives null for no match, a null country when there is none, and throws with the status only', async () => {
    const source = (body: unknown, status = 200) => new GooglePhotoSource('key-123', (async () => json(status, body)) as typeof fetch);

    expect(await source({}).resolveDestination('x')).toBeNull();
    expect(await source({ places: [{ id: 'a', addressComponents: [] }] }).resolveDestination('x')).toEqual({ placeId: 'a', countryCode: null });
    await expect(source({ error: 'key-123 is bad' }, 403).resolveDestination('x')).rejects.toThrow(/^Places search failed: HTTP 403$/);
  });

  it('refuses malformed photo names before any request', async () => {
    const fetchFn = jest.fn(async () => json(200, {}));
    const source = new GooglePhotoSource('key-123', fetchFn as unknown as typeof fetch);

    expect(await source.photoUri({ name: '../../evil', widthPx: 1, heightPx: 1, attributions: [] }, 400)).toBeNull();
    expect(await source.placePhotos('bad id')).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('MockPhotoSource', () => {
  it('resolves known cities to their countries and others to a stable one', async () => {
    const mock = new MockPhotoSource();
    expect(await mock.resolveDestination('São Paulo, Brazil')).toEqual({ placeId: 'mock-city-sao-paulo', countryCode: 'BR' });
    expect(await mock.resolveDestination('Lisbon')).toEqual({ placeId: 'mock-city-lisbon', countryCode: 'PT' });
    const first = await mock.resolveDestination('Reykjavik');
    expect(await mock.resolveDestination('reykjavik')).toEqual(first);
    expect(first.countryCode).toMatch(/^[A-Z]{2}$/);
  });

  it('slugs destinations', () => {
    expect(destinationSlug('  Rio de Janeiro, RJ ')).toBe('rio-de-janeiro');
    expect(destinationSlug('!!!')).toBe('city');
  });
});
