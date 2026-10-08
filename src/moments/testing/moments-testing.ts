/** TEST ONLY: the AI tables plus moments and achievements, an in-memory object storage, and a module wiring every Moments feature. */
import { randomUUID } from 'node:crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { Trip } from '../../trips/trip.entity.js';
import { User } from '../../users/user.entity.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import { appTestingModule } from '../../testing/app-testing.js';
import { aiDb } from '../../ai/testing/ai-db.js';
import { AiConversation } from '../../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../../ai/entities/ai-message.entity.js';
import { TripPlace } from '../../ai/entities/trip-place.entity.js';
import { AiModule } from '../../ai/ai.module.js';
import { MembersModule } from '../../members/members.module.js';
import { MediaModule } from '../../media/media.module.js';
import { AchievementsModule } from '../../achievements/achievements.module.js';
import { UserAchievement } from '../../achievements/user-achievement.entity.js';
import { Moment } from '../moment.entity.js';
import { MomentsModule } from '../moments.module.js';
import { OBJECT_STORAGE } from '../storage/object-storage.js';
import type { ObjectStorage, PresignedUpload, StorageRequestContext, StoredObject } from '../storage/object-storage.js';

export function momentsDb(): InMemoryDb {
  return aiDb()
    .define(Moment, {
      primary: ['id'],
      generate: () => ({ createdAt: new Date(), completedAt: null, lat: null, lng: null }),
      relations: {
        trip: { entity: Trip, column: 'tripId', onDelete: 'SET NULL' },
        user: { entity: User, column: 'userId' },
      },
    })
    .define(UserAchievement, {
      primary: ['id'],
      // Like UQ_user_achievements_user_key_trip (NULL trip ids are equal there too).
      unique: [['userId', 'key', 'tripId']],
      generate: () => ({ id: randomUUID(), unlockedAt: new Date(), seenAt: null }),
      relations: { trip: { entity: Trip, column: 'tripId' }, user: { entity: User, column: 'userId' } },
    });
}

/** Object storage in memory: `put` simulates the client's upload; signed URLs are recognisable fakes. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly objects = new Map<string, StoredObject>();
  readonly deleted: string[] = [];
  failDeletes = false;

  put(key: string, size: number, contentType: string | null = 'image/jpeg') {
    this.objects.set(key, { size, contentType });
  }

  async presignUpload(key: string, file: { contentType: string; byteSize: number }, context: StorageRequestContext): Promise<PresignedUpload> {
    return {
      url: `https://bucket.test/${key}?signed=put&size=${file.byteSize}&base=${encodeURIComponent(context.baseUrl)}`,
      method: 'PUT',
      headers: { 'Content-Type': file.contentType },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    };
  }

  async presignDownload(key: string): Promise<string> {
    return `https://bucket.test/${key}?signed=get`;
  }

  async stat(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    if (this.failDeletes) throw new Error('storage down');
    this.deleted.push(key);
    this.objects.delete(key);
  }

  reset() {
    this.objects.clear();
    this.deleted.length = 0;
    this.failDeletes = false;
  }
}

/** Every Moments feature (AI, members, media, moments, achievements) over `db`, mock Places, and `storage` if given. */
export function momentsTestingModule(db: InMemoryDb, config: Record<string, string> = {}, storage?: ObjectStorage): TestingModuleBuilder {
  let builder = appTestingModule(db, [AiModule, MembersModule, MediaModule, MomentsModule, AchievementsModule], {
    FREE_AI_MESSAGES_PER_DAY: '1000',
    ...config,
  });
  for (const entity of [AiConversation, AiMessage, TripPlace, Moment, UserAchievement]) {
    builder = builder.overrideProvider(getRepositoryToken(entity)).useValue(db.repository(entity as never));
  }
  if (storage) builder = builder.overrideProvider(OBJECT_STORAGE).useValue(storage);
  return builder;
}
