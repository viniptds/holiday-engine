import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from './auth-user.js';

/** The header the app sends on every request with its IANA time zone (e.g. `America/Sao_Paulo`). */
export const TIMEZONE_HEADER = 'x-timezone';
export const DEFAULT_TIMEZONE = 'UTC';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached formatter giving the local calendar date (and hour) in `zone`; throws for an unknown zone. */
function formatter(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size > 500) formatters.clear();
    formatters.set(zone, format);
  }
  return format;
}

/** True for an IANA zone `Intl.DateTimeFormat` accepts (short, no control characters). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    formatter(value);
    return true;
  } catch {
    return false;
  }
}

/** The local calendar date in `zone` at `instant`, as a sortable number YYYYMMDD. */
function localDate(zone: string, instant: number): number {
  const parts = formatter(zone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return get('year') * 10_000 + get('month') * 100 + get('day');
}

/**
 * The first instant whose local date in `zone` is on or after `date` (YYYYMMDD). The local date
 * only moves forward as time does, so a binary search finds it; this is DST-safe, including zones
 * where a transition skips or repeats local midnight.
 */
function startOfLocalDate(zone: string, date: number, around: number): number {
  let low = around - 36 * 3_600_000;
  let high = around + 36 * 3_600_000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(zone, middle) >= date) high = middle;
    else low = middle;
  }
  return high;
}

const toIsoDate = (date: number) =>
  `${Math.floor(date / 10_000)}-${String(Math.floor(date / 100) % 100).padStart(2, '0')}-${String(date % 100).padStart(2, '0')}`;

/** The local calendar date (`YYYY-MM-DD`) in `zone` at `instant`. */
export function localIsoDate(zone: string, instant: Date = new Date()): string {
  return toIsoDate(localDate(zone, instant.getTime()));
}

const nextDate = (date: number) => {
  const d = new Date(Date.UTC(Math.floor(date / 10_000), (Math.floor(date / 100) % 100) - 1, (date % 100) + 1));
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

/** Today in `zone` at `now`: [local midnight, next local midnight), as instants. */
export function localDayBounds(zone: string, now: Date = new Date()): { start: Date; end: Date } {
  const instant = now.getTime();
  const today = localDate(zone, instant);
  return {
    start: new Date(startOfLocalDate(zone, today, instant)),
    end: new Date(startOfLocalDate(zone, nextDate(today), instant + 24 * 3_600_000)),
  };
}

const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** The instant when the wall clock in `zone` reads `hour`:00 on `isoDate` (YYYY-MM-DD). DST-safe: a skipped hour gives the next valid instant. */
export function zonedInstant(zone: string, isoDate: string, hour: number): Date {
  let format = wallClocks.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    if (wallClocks.size > 500) wallClocks.clear();
    wallClocks.set(zone, format);
  }
  const [y, m, d] = isoDate.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour);
  /** The zone's offset (local wall time minus UTC) at `instant`, in ms. */
  const offset = (instant: number) => {
    const parts = Object.fromEntries(format!.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
    return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - instant;
  };
  let instant = target - offset(target);
  instant = target - offset(instant);
  return new Date(instant);
}

type RequestWithZone = { headers: Record<string, string | string[] | undefined>; user?: AuthUser };

/** The zone for a request: a valid `X-Timezone`, else the user's stored zone, else UTC. */
export function requestTimeZone(request: RequestWithZone): string {
  const header = request.headers[TIMEZONE_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (isValidTimeZone(value?.trim())) return value!.trim();
  return isValidTimeZone(request.user?.timezone) ? request.user!.timezone! : DEFAULT_TIMEZONE;
}

/** `@RequestTimezone()`: see `requestTimeZone`. */
export const RequestTimezone = createParamDecorator((_data: unknown, context: ExecutionContext): string =>
  requestTimeZone(context.switchToHttp().getRequest<RequestWithZone>()),
);
