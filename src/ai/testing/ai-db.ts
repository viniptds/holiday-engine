/** TEST ONLY: `appDb()` plus the AI tables, and a testing module wiring `AiModule` over it. */
import { randomUUID } from 'node:crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Trip } from '../../trips/trip.entity.js';
import { appDb } from '../../testing/app-db.js';
import { appTestingModule } from '../../testing/app-testing.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import { AiConversation } from '../entities/ai-conversation.entity.js';
import { AiMessage } from '../entities/ai-message.entity.js';
import { TripPlace } from '../entities/trip-place.entity.js';
import { AiModule } from '../ai.module.js';

export function aiDb(): InMemoryDb {
  return appDb()
    .define(AiConversation, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), title: null, tripId: null }),
      updateDate: 'updatedAt',
    })
    .define(AiMessage, {
      primary: ['id'],
      generate: () => ({
        id: randomUUID(),
        createdAt: new Date(),
        draft: null,
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      }),
      relations: { conversation: { entity: AiConversation, column: 'conversationId' } },
    })
    .define(TripPlace, {
      primary: ['id'],
      unique: [['tripId', 'googlePlaceId']],
      generate: () => ({ id: randomUUID(), createdAt: new Date() }),
      relations: { trip: { entity: Trip, column: 'tripId' } },
    });
}

/** A testing module with `AiModule` (mock providers unless `config` says otherwise) over `db`. */
export function aiTestingModule(db: InMemoryDb, config: Record<string, string> = {}): TestingModuleBuilder {
  let builder = appTestingModule(db, [AiModule], config);
  for (const entity of [AiConversation, AiMessage, TripPlace]) {
    builder = builder.overrideProvider(getRepositoryToken(entity)).useValue(db.repository(entity as never));
  }
  return builder;
}
