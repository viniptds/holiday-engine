import type { PlaceCategory } from '../ai.types.js';

// Google Places (New) types → our categories. Checked in the order Google lists the types (the
// primary type first), so a "bar_and_grill" that is also a "bar" counts as food.
const EXACT: Record<string, PlaceCategory> = {
  restaurant: 'food',
  cafe: 'food',
  coffee_shop: 'food',
  bakery: 'food',
  meal_takeaway: 'food',
  meal_delivery: 'food',
  food: 'food',
  food_court: 'food',
  ice_cream_shop: 'food',
  dessert_shop: 'food',
  sandwich_shop: 'food',
  deli: 'food',
  bar_and_grill: 'food',
  tourist_attraction: 'sight',
  museum: 'sight',
  historical_landmark: 'sight',
  historical_place: 'sight',
  cultural_landmark: 'sight',
  monument: 'sight',
  art_gallery: 'sight',
  church: 'sight',
  place_of_worship: 'sight',
  observation_deck: 'sight',
  visitor_center: 'sight',
  park: 'nature',
  national_park: 'nature',
  state_park: 'nature',
  garden: 'nature',
  botanical_garden: 'nature',
  beach: 'nature',
  hiking_area: 'nature',
  natural_feature: 'nature',
  night_club: 'nightlife',
  bar: 'nightlife',
  pub: 'nightlife',
  wine_bar: 'nightlife',
  karaoke: 'nightlife',
  shopping_mall: 'shopping',
  market: 'shopping',
  store: 'shopping',
  department_store: 'shopping',
  supermarket: 'shopping',
  gift_shop: 'shopping',
  amusement_park: 'activity',
  aquarium: 'activity',
  zoo: 'activity',
  water_park: 'activity',
  stadium: 'activity',
  movie_theater: 'activity',
  performing_arts_theater: 'activity',
  concert_hall: 'activity',
  spa: 'activity',
  gym: 'activity',
  bowling_alley: 'activity',
  golf_course: 'activity',
  ski_resort: 'activity',
  tour_agency: 'activity',
  event_venue: 'activity',
  lodging: 'stay',
  hotel: 'stay',
  hostel: 'stay',
  motel: 'stay',
  resort_hotel: 'stay',
  bed_and_breakfast: 'stay',
  guest_house: 'stay',
  campground: 'stay',
};

/** The category for Google's `types`: the first type that maps to one, else `other`. */
export function deriveCategory(types: readonly string[]): PlaceCategory {
  for (const type of types) {
    if (Object.hasOwn(EXACT, type)) return EXACT[type];
    if (type.endsWith('_restaurant')) return 'food';
    if (type.endsWith('_store')) return 'shopping';
  }
  return 'other';
}

/** The Text Search `includedType` hint for a category filter (none for activity and other). */
export const INCLUDED_TYPE: Partial<Record<PlaceCategory, string>> = {
  food: 'restaurant',
  sight: 'tourist_attraction',
  nature: 'park',
  nightlife: 'night_club',
  shopping: 'shopping_mall',
  stay: 'lodging',
};
