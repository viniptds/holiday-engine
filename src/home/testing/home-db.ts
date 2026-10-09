/** TEST ONLY: `aiDb()` plus `home_copy`, and a testing module wiring `HomeModule` (mock providers, fake fetch). */
import { randomUUID } from 'node:crypto';
import { ScheduleModule } from '@nestjs/schedule';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { aiDb } from '../../ai/testing/ai-db.js';
import { appTestingModule } from '../../testing/app-testing.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import { AiConversation } from '../../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../../ai/entities/ai-message.entity.js';
import { TripPlace } from '../../ai/entities/trip-place.entity.js';
import type { FetchFn } from '../../ai/llm/http-json.js';
import { HomeCopy } from '../home-copy.entity.js';
import { HomeModule } from '../home.module.js';
import { HOME_FETCH } from '../home.types.js';

export function homeDb(): InMemoryDb {
  return aiDb().define(HomeCopy, {
    primary: ['id'],
    unique: [['destinationId', 'tier', 'locale', 'angle']],
    generate: () => ({ id: randomUUID(), createdAt: new Date(), angle: '', model: null }),
  });
}

/** Open-Meteo and Nager.Date answers for tests; the real APIs are never called. */
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const openMeteoBody = (tempC = 19, wmo = 61, days = 7) => ({
  timezone: 'Europe/Lisbon',
  current: { temperature_2m: tempC, apparent_temperature: tempC - 1, weather_code: wmo },
  daily: {
    time: Array.from({ length: days }, (_, i) => `2026-10-${String(9 + i).padStart(2, '0')}`),
    weather_code: Array.from({ length: days }, (_, i) => (i === 0 ? wmo : 1)),
    temperature_2m_max: Array.from({ length: days }, () => tempC + 2),
    temperature_2m_min: Array.from({ length: days }, () => tempC - 5),
  },
});

/** A testing module with `HomeModule` over `db`, with `fetchFn` standing in for the weather and holiday APIs. */
export function homeTestingModule(db: InMemoryDb, fetchFn: FetchFn, config: Record<string, string> = {}): TestingModuleBuilder {
  let builder = appTestingModule(db, [ScheduleModule.forRoot(), HomeModule], config).overrideProvider(HOME_FETCH).useValue(fetchFn);
  for (const entity of [AiConversation, AiMessage, TripPlace, HomeCopy]) {
    builder = builder.overrideProvider(getRepositoryToken(entity)).useValue(db.repository(entity as never));
  }
  return builder;
}
