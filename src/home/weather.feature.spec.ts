import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { ANA, bootHome, LISBON } from './testing/harness.js';
import type { HomeHarness } from './testing/harness.js';
import { parseHolidays } from './holidays.service.js';
import type { WeatherDto } from './home.types.js';
import { parseForecast, roundCoordinate, timezoneCity } from './weather.service.js';
import { weatherCodeOf, weatherText } from './wmo.js';

describe('Home: weather proxy (feature)', () => {
  let h: HomeHarness;
  const logged: string[] = [];

  beforeAll(async () => {
    h = await bootHome({ HOME_WEATHER_CACHE_MINUTES: '30' });
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await h.close();
  });

  beforeEach(() => {
    h.reset();
    logged.length = 0;
  });

  it('maps WMO codes to the icon set with localized texts', () => {
    expect(weatherCodeOf(0)).toBe('clear');
    expect(weatherCodeOf(2)).toBe('partlyCloudy');
    expect(weatherCodeOf(3)).toBe('cloudy');
    expect(weatherCodeOf(45)).toBe('fog');
    expect(weatherCodeOf(53)).toBe('drizzle');
    expect(weatherCodeOf(57)).toBe('freezingRain');
    expect(weatherCodeOf(63)).toBe('rain');
    expect(weatherCodeOf(75)).toBe('snow');
    expect(weatherCodeOf(81)).toBe('showers');
    expect(weatherCodeOf(86)).toBe('snowShowers');
    expect(weatherCodeOf(95)).toBe('thunderstorm');
    expect(weatherCodeOf(999)).toBe('cloudy');
    expect(weatherText('rain', 'en')).toBe('Rain');
    expect(weatherText('rain', 'pt-BR')).toBe('Chuva');
    expect(weatherText('rain', 'es')).toBe('Lluvia');
  });

  it('rounds coordinates to 2 decimals before calling Open-Meteo and returns the forecast in the request language', async () => {
    const { status, body } = await h.json<WeatherDto>('GET', `/home/weather?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA, undefined, { 'accept-language': 'pt-BR' });
    expect(status).toBe(200);
    const url = new URL(h.apis.weatherCalls()[0]);
    expect(url.searchParams.get('latitude')).toBe('38.72');
    expect(url.searchParams.get('longitude')).toBe('-9.14');
    expect(url.searchParams.get('timezone')).toBe('auto');
    expect(url.searchParams.get('forecast_days')).toBe('7');
    expect(body.place).toEqual({ name: 'Lisboa', country: 'PT' });
    expect(body.current).toEqual({ tempC: 19, feelsLikeC: 18, code: 'rain', text: 'Chuva' });
    expect(body.today).toEqual({ maxC: 21, minC: 14 });
    expect(body.daily).toHaveLength(7);
    expect(body.daily[0]).toEqual({ date: '2026-10-09', code: 'rain', maxC: 21, minC: 14 });
    expect(body.daily[1].code).toBe('partlyCloudy');
    expect(body.updatedAt).toBe('2026-10-09T10:00:00.000Z');
    expect(roundCoordinate(38.7223)).toBe(38.72);
    expect(roundCoordinate(-9.1393)).toBe(-9.14);
  });

  it('serves nearby positions from the same cache entry for 30 minutes, then refreshes', async () => {
    await h.json('GET', `/home/weather?lat=38.7223&lng=-9.1393`, ANA);
    await h.json('GET', `/home/weather?lat=38.7190&lng=-9.1420`, ANA, undefined, { 'accept-language': 'es' });
    expect(h.apis.weatherCalls()).toHaveLength(1);
    const service = h.moduleRef.get((await import('./weather.service.js')).WeatherService);
    service.now = () => new Date('2026-10-09T10:29:00Z');
    await h.json('GET', `/home/weather?lat=38.7223&lng=-9.1393`, ANA);
    expect(h.apis.weatherCalls()).toHaveLength(1);
    service.now = () => new Date('2026-10-09T10:31:00Z');
    const refreshed = await h.json<WeatherDto>('GET', `/home/weather?lat=38.7223&lng=-9.1393`, ANA);
    expect(h.apis.weatherCalls()).toHaveLength(2);
    expect(refreshed.body.updatedAt).toBe('2026-10-09T10:31:00.000Z');
  });

  it('answers by catalog city and falls back to the time zone city away from the catalog', async () => {
    const porto = await h.json<WeatherDto>('GET', '/home/weather?city=porto', ANA, undefined, { 'accept-language': 'es' });
    expect(porto.status).toBe(200);
    expect(porto.body.place).toEqual({ name: 'Oporto', country: 'PT' });
    expect(new URL(h.apis.weatherCalls()[0]).searchParams.get('latitude')).toBe('41.15');
    const unknown = await h.json('GET', '/home/weather?city=atlantis', ANA);
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('VALIDATION');
    const remote = await h.json<WeatherDto>('GET', '/home/weather?lat=40.0&lng=-9.0', ANA);
    expect(remote.body.place).toEqual({ name: 'Lisbon', country: null });
    expect(timezoneCity('America/Sao_Paulo')).toBe('Sao Paulo');
    expect(timezoneCity(null)).toBe('');
  });

  it('rejects bad queries', async () => {
    expect((await h.json('GET', '/home/weather', ANA)).status).toBe(400);
    expect((await h.json('GET', '/home/weather?lat=91&lng=0', ANA)).status).toBe(400);
    expect((await h.json('GET', '/home/weather?lat=1', ANA)).status).toBe(400);
    expect((await h.json('GET', '/home/weather?lat=1&lng=1', null)).status).toBe(401);
  });

  it('answers 503 WEATHER_UNAVAILABLE on a failure, never logging the position, and does not cache it', async () => {
    h.apis.weatherFailing = true;
    const failed = await h.json('GET', `/home/weather?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA);
    expect(failed.status).toBe(503);
    expect(failed.body).toEqual({ code: 'WEATHER_UNAVAILABLE', message: 'Weather is unavailable right now' });
    expect(logged.some((l) => l.includes('forecast request failed (HTTP 503)'))).toBe(true);
    expect(logged.join('\n')).not.toMatch(/38\.7|-9\.1/);
    h.apis.weatherFailing = false;
    expect((await h.json('GET', `/home/weather?lat=${LISBON.lat}&lng=${LISBON.lng}`, ANA)).status).toBe(200);
    expect(h.apis.weatherCalls()).toHaveLength(2);
  });

  it('parses provider answers defensively', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    expect(parseForecast({}, now)).toBeNull();
    expect(parseForecast({ current: { temperature_2m: 1, weather_code: 0 }, daily: { time: [] } }, now)).toBeNull();
    expect(parseForecast({ current: { temperature_2m: 1, weather_code: 0 }, daily: { time: ['2026-10-09'], temperature_2m_max: ['x'], temperature_2m_min: [1] } }, now)).toBeNull();
    expect(parseHolidays({ nope: true })).toBeNull();
    expect(parseHolidays([{ date: '2026-12-01', name: 'Restoration', localName: 'Restauração', global: true, types: ['Public'] }, { date: 'bad' }, { date: '2026-12-02', name: 'Local', global: false, counties: ['PT-11'] }])).toEqual([
      { date: '2026-12-01', name: 'Restoration', localName: 'Restauração' },
    ]);
  });
});
