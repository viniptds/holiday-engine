import { ConfigService } from '@nestjs/config';
import { DEFAULT_HOME_COPY_AI_MAX_PER_NIGHT, DEFAULT_WEATHER_CACHE_MINUTES } from './home.types.js';

export type HomeConfig = {
  weatherCacheMs: number;
  copyAiRefresh: boolean;
  copyAiMaxPerNight: number;
};

/** `HOME_*` settings; an invalid value fails startup naming the setting. */
export function readHomeConfig(get: (key: string) => string | undefined): HomeConfig {
  const minutes = get('HOME_WEATHER_CACHE_MINUTES');
  const cacheMinutes = minutes === undefined || minutes === '' ? DEFAULT_WEATHER_CACHE_MINUTES : Number(minutes);
  if (!Number.isInteger(cacheMinutes) || cacheMinutes < 1) throw new Error('HOME_WEATHER_CACHE_MINUTES must be a whole number of minutes, at least 1');

  const refresh = (get('HOME_COPY_AI_REFRESH') ?? 'false').trim().toLowerCase();
  if (refresh !== 'true' && refresh !== 'false' && refresh !== '') throw new Error('HOME_COPY_AI_REFRESH must be true or false');

  const maxRaw = get('HOME_COPY_AI_MAX_PER_NIGHT');
  const maxPerNight = maxRaw === undefined || maxRaw === '' ? DEFAULT_HOME_COPY_AI_MAX_PER_NIGHT : Number(maxRaw);
  if (!Number.isInteger(maxPerNight) || maxPerNight < 0) throw new Error('HOME_COPY_AI_MAX_PER_NIGHT must be a whole number, 0 or more');

  return { weatherCacheMs: cacheMinutes * 60_000, copyAiRefresh: refresh === 'true', copyAiMaxPerNight: maxPerNight };
}

export const homeConfigFrom = (config: ConfigService): HomeConfig => readHomeConfig((key) => config.get<string>(key));
