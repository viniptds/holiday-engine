// Calendar days are UTC, like the suggestions cron.
const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight UTC of the day containing `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Last millisecond (UTC) of the day containing `date`. */
export function endOfUtcDay(date: Date): Date {
  return new Date(startOfUtcDay(date).getTime() + DAY_MS - 1);
}

export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Parses a `YYYY-MM-DD` string as midnight UTC. */
export function parseDateOnly(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  return date;
}

/** Formats as `YYYY-MM-DD` (UTC). */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
