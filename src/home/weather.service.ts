import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { Locale } from '../app-common/locale.js';
import { TtlLru } from '../app-common/ttl-lru.js';
import type { FetchFn } from '../ai/llm/http-json.js';
import { DestinationCatalog } from './catalog.js';
import type { HomeConfig } from './home.config.js';
import { DESTINATION_CATALOG, HOME_CONFIG, HOME_FETCH, HOME_FETCH_TIMEOUT_MS, OPEN_METEO_FORECAST_URL, PLACE_NAME_KM, WEATHER_CACHE_SIZE } from './home.types.js';
import type { Destination, WeatherDto } from './home.types.js';
import { weatherCodeOf, weatherText } from './wmo.js';

/** A forecast as the proxy keeps it: codes unmapped and texts unlocalized, so one cache entry serves every language. */
export type Forecast = {
  current: { tempC: number; feelsLikeC: number; wmo: number };
  daily: { date: string; wmo: number; maxC: number; minC: number }[];
  /** Open-Meteo's `timezone=auto` answer, e.g. `Europe/Lisbon`. */
  timezone: string | null;
  updatedAt: string;
};

export class WeatherUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`Weather unavailable: ${reason}`);
    this.name = 'WeatherUnavailableError';
  }
}

/** Coordinates rounded to 2 decimals (about 1 km): what leaves the engine and what the cache keys on. */
export function roundCoordinate(value: number): number {
  return Math.round(value * 100) / 100;
}

type OpenMeteoBody = {
  timezone?: string;
  current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number };
  daily?: { time?: string[]; weather_code?: number[]; temperature_2m_max?: number[]; temperature_2m_min?: number[] };
};

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Open-Meteo's forecast JSON → `Forecast`, or null when a field we need is missing. */
export function parseForecast(body: unknown, now: Date): Forecast | null {
  const b = body as OpenMeteoBody;
  const c = b?.current;
  const d = b?.daily;
  if (!c || !d || !isNum(c.temperature_2m) || !isNum(c.weather_code) || !Array.isArray(d.time)) return null;
  const daily = d.time.slice(0, 7).map((date, i) => ({
    date,
    wmo: d.weather_code?.[i] ?? 3,
    maxC: d.temperature_2m_max?.[i],
    minC: d.temperature_2m_min?.[i],
  }));
  if (daily.length === 0 || !daily.every((day) => typeof day.date === 'string' && isNum(day.maxC) && isNum(day.minC) && isNum(day.wmo))) return null;
  return {
    current: { tempC: c.temperature_2m, feelsLikeC: isNum(c.apparent_temperature) ? c.apparent_temperature : c.temperature_2m, wmo: c.weather_code },
    daily: daily as Forecast['daily'],
    timezone: typeof b.timezone === 'string' ? b.timezone : null,
    updatedAt: now.toISOString(),
  };
}

/**
 * The weather proxy over Open-Meteo (free, no key). Forecasts are cached per rounded position for
 * `HOME_WEATHER_CACHE_MINUTES`; nothing is stored per user, and positions are never logged.
 */
@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  private readonly forecasts: TtlLru<string, Forecast>;
  /** Tests override this. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(HOME_FETCH) private readonly fetchFn: FetchFn,
    @Inject(DESTINATION_CATALOG) private readonly catalog: DestinationCatalog,
    @Inject(HOME_CONFIG) config: HomeConfig,
  ) {
    this.forecasts = new TtlLru(WEATHER_CACHE_SIZE, config.weatherCacheMs, () => this.now().getTime());
  }

  /** `GET /home/weather`: by position, or by catalog destination id. Throws `503 WEATHER_UNAVAILABLE` on any failure. */
  async weather(query: { lat: number; lng: number } | { city: string }, locale: Locale): Promise<WeatherDto> {
    let position: { lat: number; lng: number };
    let place: Destination | undefined;
    if ('city' in query) {
      place = this.catalog.get(query.city);
      if (!place) throw new AppError('VALIDATION', 'Unknown city', { city: 'Unknown destination id' });
      position = { lat: place.lat, lng: place.lng };
    } else {
      position = { lat: roundCoordinate(query.lat), lng: roundCoordinate(query.lng) };
      place = this.catalog.nearest(position, PLACE_NAME_KM)?.destination;
    }
    let forecast: Forecast;
    try {
      forecast = await this.forecast(position);
    } catch {
      throw new AppError('WEATHER_UNAVAILABLE', 'Weather is unavailable right now');
    }
    return this.present(forecast, place, locale);
  }

  /** The destination's current temperature (whole °C) from the cached forecast, or undefined when the lookup fails. */
  async currentTempC(destination: Destination): Promise<number | undefined> {
    try {
      const forecast = await this.forecast({ lat: roundCoordinate(destination.lat), lng: roundCoordinate(destination.lng) });
      return Math.round(forecast.current.tempC);
    } catch {
      return undefined;
    }
  }

  /** Cached per rounded position. */
  async forecast(position: { lat: number; lng: number }): Promise<Forecast> {
    const key = `${position.lat.toFixed(2)},${position.lng.toFixed(2)}`;
    const cached = this.forecasts.get(key);
    if (cached) return cached;
    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set('latitude', position.lat.toFixed(2));
    url.searchParams.set('longitude', position.lng.toFixed(2));
    url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code');
    url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min');
    url.searchParams.set('timezone', 'auto');
    url.searchParams.set('forecast_days', '7');
    let response: Response;
    try {
      response = await this.fetchFn(url, { signal: AbortSignal.timeout(HOME_FETCH_TIMEOUT_MS) });
    } catch (error) {
      this.logger.warn(`Weather: forecast request failed (${(error as Error).name})`);
      throw new WeatherUnavailableError((error as Error).name);
    }
    if (!response.ok) {
      this.logger.warn(`Weather: forecast request failed (HTTP ${response.status})`);
      throw new WeatherUnavailableError(`http_${response.status}`);
    }
    const forecast = parseForecast(await response.json().catch(() => null), this.now());
    if (!forecast) {
      this.logger.warn('Weather: forecast response was not in the expected shape');
      throw new WeatherUnavailableError('bad_response');
    }
    this.forecasts.set(key, forecast);
    return forecast;
  }

  private present(forecast: Forecast, place: Destination | undefined, locale: Locale): WeatherDto {
    const code = weatherCodeOf(forecast.current.wmo);
    const today = forecast.daily[0];
    return {
      // No reverse geocoder without a key: the nearest catalog city, else the forecast's time zone city ("Europe/Lisbon" → "Lisbon").
      place: place ? { name: place.names[locale], country: place.country } : { name: timezoneCity(forecast.timezone), country: null },
      current: { tempC: Math.round(forecast.current.tempC), feelsLikeC: Math.round(forecast.current.feelsLikeC), code, text: weatherText(code, locale) },
      today: { maxC: Math.round(today.maxC), minC: Math.round(today.minC) },
      daily: forecast.daily.map((day) => ({ date: day.date, code: weatherCodeOf(day.wmo), maxC: Math.round(day.maxC), minC: Math.round(day.minC) })),
      updatedAt: forecast.updatedAt,
    };
  }
}

/** `America/Sao_Paulo` → `Sao Paulo`; unknown → `Your location` is the app's job, so an empty zone gives ''. */
export function timezoneCity(timezone: string | null): string {
  if (!timezone) return '';
  const last = timezone.split('/').pop() ?? '';
  return last.replace(/_/g, ' ');
}
