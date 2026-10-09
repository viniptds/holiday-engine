/** TEST ONLY: boots the Home features over HTTP with fake Open-Meteo and Nager.Date answers. */
import { jest } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Trip } from '../../trips/trip.entity.js';
import { TripMember } from '../../app-trips/trip-member.entity.js';
import type { TripRole } from '../../app-trips/app-trips.types.js';
import { accessTokens, seedUser } from '../../testing/app-testing.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import { BannersService } from '../banners.service.js';
import { CopyRefreshService } from '../copy-refresh.service.js';
import { HolidaysService } from '../holidays.service.js';
import { TrendingService } from '../trending.service.js';
import { WeatherService } from '../weather.service.js';
import { homeDb, homeTestingModule, json, openMeteoBody } from './home-db.js';

export const ANA = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const BEN = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const USERS = [ANA, BEN];
/** Friday 2026-10-09, 10:00 UTC: every clock in the harness starts here. */
export const NOW = new Date('2026-10-09T10:00:00Z');
export const LISBON = { lat: 38.7223, lng: -9.1393 };

/** Nager.Date's answer per country: a Sunday (no block), a Tuesday (4 days) and a Friday (3 days). */
export const HOLIDAYS: Record<string, unknown[]> = {
  PT: [
    { date: '2026-11-01', localName: 'Dia de Todos os Santos', name: "All Saints' Day", countryCode: 'PT', global: true, counties: null, types: ['Public'] },
    { date: '2026-12-01', localName: 'Restauração da Independência', name: 'Restoration of Independence', countryCode: 'PT', global: true, counties: null, types: ['Public'] },
    { date: '2026-12-25', localName: 'Natal', name: 'Christmas Day', countryCode: 'PT', global: true, counties: null, types: ['Public'] },
  ],
  BR: [{ date: '2026-11-02', localName: 'Dia de Finados', name: "All Souls' Day", countryCode: 'BR', global: true, counties: null, types: ['Public'] }],
};

/** A fake Open-Meteo and Nager.Date, recording every call. */
export class FakeApis {
  calls: string[] = [];
  weatherFailing = false;
  holidaysFailing = false;
  tempC = 19;

  fetch = jest.fn(async (input: string | URL | Request): Promise<Response> => {
    const url = String(input);
    this.calls.push(url);
    if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
      return this.weatherFailing ? json(503, { error: true }) : json(200, openMeteoBody(this.tempC));
    }
    const nager = url.match(/^https:\/\/date\.nager\.at\/api\/v3\/PublicHolidays\/(\d{4})\/([A-Z]{2})$/);
    if (nager) {
      if (this.holidaysFailing) return json(500, {});
      const list = (HOLIDAYS[nager[2]] ?? []).filter((h) => (h as { date: string }).date.startsWith(nager[1]));
      return list.length > 0 ? json(200, list) : new Response(null, { status: 204 });
    }
    return json(500, {});
  });

  reset() {
    this.calls = [];
    this.weatherFailing = false;
    this.holidaysFailing = false;
    this.tempC = 19;
    this.fetch.mockClear();
  }

  weatherCalls() {
    return this.calls.filter((u) => u.includes('open-meteo'));
  }

  holidayCalls() {
    return this.calls.filter((u) => u.includes('nager'));
  }
}

export type HomeHarness = {
  app: INestApplication;
  moduleRef: TestingModule;
  db: InMemoryDb;
  apis: FakeApis;
  json: <T = Record<string, unknown>>(method: string, path: string, user: string | null, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
  seedUsers: () => void;
  seedTrip: (owner: string, fields?: Partial<Trip>, members?: [string, TripRole][]) => Trip;
  /** Fresh caches and clocks at `now` on every service. */
  reset: (now?: Date) => void;
  close: () => Promise<void>;
};

export async function bootHome(config: Record<string, string> = {}): Promise<HomeHarness> {
  const db = homeDb();
  const apis = new FakeApis();
  const moduleRef = await homeTestingModule(db, apis.fetch, config).compile();
  const tokens = await accessTokens(moduleRef, USERS);
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = `${await app.getUrl()}/app/v1`;

  const call: HomeHarness['json'] = async (method, path, user, body, headers = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as never };
  };

  const reset = (now: Date = NOW) => {
    db.clear();
    apis.reset();
    const banners = moduleRef.get(BannersService);
    const weather = moduleRef.get(WeatherService);
    const trending = moduleRef.get(TrendingService);
    const refresh = moduleRef.get(CopyRefreshService);
    banners.resetCache();
    trending.reset();
    moduleRef.get(HolidaysService).reset();
    banners.now = () => now;
    weather.now = () => now;
    trending.now = () => now;
    refresh.now = () => now;
    // The forecast cache is per process: a fresh service state per test.
    (weather as unknown as { forecasts: { clear(): void } }).forecasts.clear();
    for (const id of USERS) seedUser(db, id);
  };

  return {
    app,
    moduleRef,
    db,
    apis,
    json: call,
    seedUsers: () => {
      for (const id of USERS) seedUser(db, id);
    },
    seedTrip: (owner, fields = {}, members = [[owner, 'owner']]) => {
      const trip = db.seed(Trip, {
        provider: null,
        chatId: null,
        ownerUserId: owner,
        destination: 'Porto',
        startDate: '2026-11-20',
        endDate: '2026-11-23',
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
        countryCode: null,
        cityPlaceId: null,
        createdAt: NOW,
        ...fields,
      });
      for (const [userId, role] of members) db.seed(TripMember, { tripId: trip.id, userId, role });
      return trip;
    },
    reset,
    close: () => app.close(),
  };
}
