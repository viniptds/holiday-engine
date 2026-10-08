/** Per trip, planning: unlocked for every member of the trip. */
export const PLANNING_KEYS = ['trip_created', 'first_place', 'all_days_planned', 'first_member_joined'] as const;
export type PlanningKey = (typeof PLANNING_KEYS)[number];
/** Per trip, date-based (each member's own time zone). `day_completed:<n>` too. */
export const TRIP_STARTED = 'trip_started';
export const TRIP_FINISHED = 'trip_finished';
export const DAY_COMPLETED_PREFIX = 'day_completed:';
/** Per user (tripId null). */
export const MOMENT_MILESTONES: [number, string][] = [
  [1, 'first_moment'],
  [10, 'moments_10'],
  [25, 'moments_25'],
  [50, 'moments_50'],
];
export const FIRST_COLLAGE_SHARED = 'first_collage_shared';
export const COUNTRY_MILESTONES: [number, string][] = [
  [1, 'countries_1'],
  [3, 'countries_3'],
  [5, 'countries_5'],
  [10, 'countries_10'],
];
export const CITY_MILESTONES: [number, string][] = [
  [5, 'cities_5'],
  [10, 'cities_10'],
];

export type AchievementDto = { key: string; tripId: string | null; unlockedAt: string; seen: boolean };

export type JourneyNodeStatus = 'locked' | 'current' | 'done';
export type JourneyNode = {
  kind: 'milestone' | 'day';
  key: string;
  title: string;
  day?: number;
  date?: string;
  status: JourneyNodeStatus;
  /** Day nodes: up to 3 signed URLs of that day's moments, newest first. */
  momentThumbs?: string[];
};

export const ACHIEVEMENT_EVENT_TYPES = ['collage_shared'] as const;
export const EVENT_RATE_LIMIT = { max: 30, windowMs: 60 * 60 * 1000 };
/** Lazy work per request: trips re-evaluated, destinations resolved. */
export const MAX_LAZY_TRIPS = 20;
export const MAX_LAZY_RESOLVES = 5;
export const MAX_THUMBS_PER_DAY = 3;
