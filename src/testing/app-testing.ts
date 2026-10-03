/**
 * TEST ONLY: builds app feature-test modules over an `InMemoryDb`, with the real AuthModule
 * (JWT access tokens) and helpers to create users and sign them in.
 */
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { TestingModule, TestingModuleBuilder } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripInvite } from '../members/trip-invite.entity.js';
import { TripRemoval } from '../members/trip-removal.entity.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from '../auth/refresh-token.entity.js';
import { AccessTokenService } from '../auth/access-token.service.js';
import type { InMemoryDb } from './in-memory-db.js';

export const TEST_JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-characters';

/** A testing module importing `imports`, with every app repository backed by `db`. */
export function appTestingModule(db: InMemoryDb, imports: unknown[], config: Record<string, string> = {}): TestingModuleBuilder {
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => ({ JWT_SECRET: TEST_JWT_SECRET, GOOGLE_CLIENT_IDS: 'test-client', ...config })],
      }),
      ...(imports as never[]),
    ],
  });
  for (const entity of [User, RefreshToken, Trip, TripMember, TripInvite, TripRemoval]) {
    builder = builder.overrideProvider(getRepositoryToken(entity)).useValue(db.repository(entity as never));
  }
  return builder;
}

/** Users default to email `<first 4 chars of id>@example.com` and display name `Traveler <first 4 chars>`. */
export function seedUser(db: InMemoryDb, id: string, fields: Partial<User> = {}): User {
  return db.seed(User, {
    id,
    googleSub: `google-${id}`,
    email: `${id.slice(0, 4)}@example.com`,
    displayName: `Traveler ${id.slice(0, 4)}`,
    avatarUrl: null,
    homeCity: null,
    ...fields,
  });
}

/** A valid access token (`Authorization: Bearer ...`) for each user id. */
export async function accessTokens(moduleRef: TestingModule, ids: string[]): Promise<Record<string, string>> {
  const service = moduleRef.get(AccessTokenService);
  const entries = await Promise.all(ids.map(async (id) => [id, (await service.issue(id)).accessToken] as const));
  return Object.fromEntries(entries);
}
