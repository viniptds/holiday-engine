import { deriveCategory, INCLUDED_TYPE } from './categories.js';
import { PLACE_CATEGORIES } from '../ai.types.js';

describe('deriveCategory', () => {
  it.each([
    [['restaurant'], 'food'],
    [['cafe'], 'food'],
    [['bakery'], 'food'],
    [['japanese_restaurant'], 'food'],
    [['tourist_attraction'], 'sight'],
    [['museum'], 'sight'],
    [['historical_landmark'], 'sight'],
    [['park'], 'nature'],
    [['beach'], 'nature'],
    [['night_club'], 'nightlife'],
    [['bar'], 'nightlife'],
    [['shopping_mall'], 'shopping'],
    [['clothing_store'], 'shopping'],
    [['zoo'], 'activity'],
    [['hotel'], 'stay'],
    [['point_of_interest'], 'other'],
    [[], 'other'],
  ])('%j → %s', (types, category) => {
    expect(deriveCategory(types)).toBe(category);
  });

  it("follows Google's order: the first type that maps wins", () => {
    expect(deriveCategory(['bar_and_grill', 'bar'])).toBe('food');
    expect(deriveCategory(['point_of_interest', 'museum', 'cafe'])).toBe('sight');
  });

  it('has a valid includedType hint for food (and only real categories)', () => {
    expect(INCLUDED_TYPE.food).toBe('restaurant');
    for (const key of Object.keys(INCLUDED_TYPE)) expect(PLACE_CATEGORIES).toContain(key);
  });
});
