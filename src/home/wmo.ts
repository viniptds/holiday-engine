import type { Locale } from '../app-common/locale.js';
import type { WeatherCode } from './home.types.js';

/** WMO weather interpretation codes (Open-Meteo) → our icon set. Unknown codes read as cloudy. */
export function weatherCodeOf(wmo: number): WeatherCode {
  if (wmo === 0) return 'clear';
  if (wmo === 1 || wmo === 2) return 'partlyCloudy';
  if (wmo === 3) return 'cloudy';
  if (wmo === 45 || wmo === 48) return 'fog';
  if (wmo >= 51 && wmo <= 55) return 'drizzle';
  if (wmo === 56 || wmo === 57 || wmo === 66 || wmo === 67) return 'freezingRain';
  if (wmo >= 61 && wmo <= 65) return 'rain';
  if (wmo >= 71 && wmo <= 77) return 'snow';
  if (wmo >= 80 && wmo <= 82) return 'showers';
  if (wmo === 85 || wmo === 86) return 'snowShowers';
  if (wmo >= 95 && wmo <= 99) return 'thunderstorm';
  return 'cloudy';
}

const TEXTS: Record<Locale, Record<WeatherCode, string>> = {
  en: {
    clear: 'Clear sky',
    partlyCloudy: 'Partly cloudy',
    cloudy: 'Overcast',
    fog: 'Fog',
    drizzle: 'Drizzle',
    rain: 'Rain',
    freezingRain: 'Freezing rain',
    showers: 'Showers',
    snow: 'Snow',
    snowShowers: 'Snow showers',
    thunderstorm: 'Thunderstorm',
  },
  'pt-BR': {
    clear: 'Céu limpo',
    partlyCloudy: 'Parcialmente nublado',
    cloudy: 'Nublado',
    fog: 'Neblina',
    drizzle: 'Garoa',
    rain: 'Chuva',
    freezingRain: 'Chuva congelante',
    showers: 'Pancadas de chuva',
    snow: 'Neve',
    snowShowers: 'Pancadas de neve',
    thunderstorm: 'Tempestade',
  },
  es: {
    clear: 'Cielo despejado',
    partlyCloudy: 'Parcialmente nublado',
    cloudy: 'Nublado',
    fog: 'Niebla',
    drizzle: 'Llovizna',
    rain: 'Lluvia',
    freezingRain: 'Lluvia helada',
    showers: 'Chubascos',
    snow: 'Nieve',
    snowShowers: 'Chubascos de nieve',
    thunderstorm: 'Tormenta',
  },
};

export function weatherText(code: WeatherCode, locale: Locale): string {
  return TEXTS[locale][code];
}
