import { MockPlacesProvider, MOCK_CENTER, MOCK_FAR_PREFIX, MOCK_MISSING_PREFIX } from './mock-places.provider.js';
import { distanceKm } from './places-verifier.js';

describe('MockPlacesProvider (itinerary)', () => {
  it('returns up to 5 deterministic search results that Place Details then finds by id', async () => {
    const mock = new MockPlacesProvider();

    const results = await mock.searchMany({ query: 'Pastel restaurant', languageCode: 'en', limit: 10 });

    expect(results).toHaveLength(5);
    expect(results[0].types).toContain('restaurant');
    expect(await mock.details(results[2].googlePlaceId)).toEqual(results[2]);
    expect(await new MockPlacesProvider().searchMany({ query: 'Pastel restaurant', languageCode: 'en', limit: 2 })).toEqual(
      results.slice(0, 2),
    );
  });

  it('knows far and missing ids for dev testing', async () => {
    const mock = new MockPlacesProvider();

    expect(await mock.details(`${MOCK_MISSING_PREFIX}1`)).toBeNull();
    expect(distanceKm(MOCK_CENTER, (await mock.details(`${MOCK_FAR_PREFIX}1`))!.location)).toBeGreaterThan(250);
    expect(distanceKm(MOCK_CENTER, (await mock.details('mock-unknown'))!.location)).toBeLessThan(1);
  });
});
