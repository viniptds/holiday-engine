/** Home tab types and limits (`docs/app-home-spec.md`, Engine). */
import type { Locale } from '../app-common/locale.js';
import type { AiConversationSummary } from '../ai/ai.types.js';

export const BANNER_TIERS = ['nearby', 'longWeekend', 'bigTrip', 'trending'] as const;
export type BannerTier = (typeof BANNER_TIERS)[number];

export const BIG_TRIP_ANGLES = ['family', 'business', 'explorer'] as const;
export type BigTripAngle = (typeof BIG_TRIP_ANGLES)[number];

export const DESTINATION_KINDS = ['city', 'region', 'island'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const CATALOG_TAGS = ['beach', 'culture', 'food', 'nature', 'nightlife', 'adventure', 'relax', 'city', 'family'] as const;
export type CatalogTag = (typeof CATALOG_TAGS)[number];

/** One `destinations.json` entry, validated at startup. */
export type Destination = {
  id: string;
  names: Record<Locale, string>;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** Lower-case, accent-free spellings that match free-text trip destinations. */
  aliases: string[];
  tags: CatalogTag[];
  /** 1-12. */
  bestMonths: number[];
  similar: string[];
  /** 1-5, the catalog's own popularity (used as a mild tie-breaker and for the trending fallback). */
  popularity: number;
  lat: number;
  lng: number;
  kind: DestinationKind;
};

/** Our icon set; WMO codes map onto it (`wmo.ts`). */
export const WEATHER_CODES = ['clear', 'partlyCloudy', 'cloudy', 'fog', 'drizzle', 'rain', 'freezingRain', 'showers', 'snow', 'snowShowers', 'thunderstorm'] as const;
export type WeatherCode = (typeof WEATHER_CODES)[number];

export type WeatherDto = {
  place: { name: string; country: string | null };
  current: { tempC: number; feelsLikeC: number; code: WeatherCode; text: string };
  today: { maxC: number; minC: number };
  daily: { date: string; code: WeatherCode; maxC: number; minC: number }[];
  updatedAt: string;
};

export type PublicHoliday = { date: string; name: string; localName: string };

export type BannerFacts = { distanceKm?: number; daysOff?: number; holidayName?: string; month?: string; tempC?: number };

export type BannerAngle = { key: BigTripAngle; headline: string; subline: string; plannerPrompt: string };

export type BannerDto = {
  tier: BannerTier;
  destinationId: string;
  name: string;
  country: string;
  eyebrow: string;
  headline: string;
  subline: string;
  cta: string;
  photo: { url: string; attributions: { displayName: string; uri: string | null }[] } | null;
  plannerPrompt: string;
  angles?: BannerAngle[];
  facts: BannerFacts;
};

export type BannersDto = { banners: BannerDto[]; generatedAt: string };

export type HomeDto = { drafts: AiConversationSummary[]; hasMoreDrafts: boolean };

export const MAX_HOME_DRAFTS = 5;

/** Selection distances (km). */
export const NEARBY_MAX_KM = 300;
export const LONG_WEEKEND_MIN_KM = 300;
export const LONG_WEEKEND_MAX_KM = 1500;
export const BIG_TRIP_MIN_KM = 1500;
/** A catalog entry this close to the user's position is their own city. */
export const OWN_CITY_KM = 30;
/** The nearest catalog entry within this distance names the weather chip's place. */
export const PLACE_NAME_KM = 50;
/** Trips starting within this many days exclude their destination from Nearby. */
export const NEARBY_EXCLUSION_DAYS = 30;
export const HOLIDAY_LOOKAHEAD_DAYS = 90;
export const BIG_TRIP_HORIZONS = [3, 6, 12] as const;
export const MAX_COUNTRY_REPEATS = 2;

/** Trending: anonymous, k-anonymous counts (`docs/app-explore-spec.md`). */
export const TRENDING_WINDOW_DAYS = 30;
export const TRENDING_MIN_USERS = 5;
export const TRENDING_BUCKETS = [50, 25, 10, 5] as const;
export const TRENDING_TTL_MS = 60 * 60 * 1000;

/** Caches (in memory, per process). */
export const BANNERS_TTL_MS = 60 * 60 * 1000;
export const BANNERS_CACHE_SIZE = 20_000;
export const WEATHER_CACHE_SIZE = 10_000;
export const HOLIDAYS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const HOLIDAYS_CACHE_SIZE = 1_000;
export const DEFAULT_WEATHER_CACHE_MINUTES = 30;

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const NAGER_HOLIDAYS_URL = 'https://date.nager.at/api/v3/PublicHolidays';
export const HOME_FETCH_TIMEOUT_MS = 8_000;

/** The fetch the weather and holiday proxies use (tests override it). */
export const HOME_FETCH = Symbol('HOME_FETCH');
export const DESTINATION_CATALOG = Symbol('DESTINATION_CATALOG');
export const HOME_COPY = Symbol('HOME_COPY');
export const HOME_CONFIG = Symbol('HOME_CONFIG');

/** Copy refresh (`HOME_COPY_AI_REFRESH`). */
export const HOME_COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_HOME_COPY_AI_MAX_PER_NIGHT = 300;
export const HOME_COPY_VARIANTS = 3;
export const HOME_COPY_REFRESH_JOB = 'home-copy-refresh';
/** 03:00 UTC, nightly. */
export const HOME_COPY_REFRESH_CRON = '0 3 * * *';
