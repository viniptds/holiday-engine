/** Longest allowed trip, in days between startDate and endDate (contract). */
export const MAX_TRIP_DAYS = 365;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const isDateOnlyString = (value: unknown): value is string => typeof value === 'string' && DATE_ONLY.test(value);

/** Whole days from `start` to `end`, both `YYYY-MM-DD`. */
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000);
}
