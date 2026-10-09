/** TEST ONLY: an `InMemoryDb` with the app tables (users, refresh_tokens, trips, trip_members, trip_invites, trip_removals). */
import { randomUUID } from 'node:crypto';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripInvite } from '../members/trip-invite.entity.js';
import { TripRemoval } from '../members/trip-removal.entity.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from '../auth/refresh-token.entity.js';
import { UserEntitlement } from '../billing/user-entitlement.entity.js';
import { BillingEvent } from '../billing/billing-event.entity.js';
import { InMemoryDb } from './in-memory-db.js';
import { IdempotencyKey } from '../idempotency/idempotency-key.entity.js';

export function appDb(): InMemoryDb {
  const tripRelation = { trip: { entity: Trip, column: 'tripId' } };
  return new InMemoryDb()
    .define(User, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), deletedAt: null, timezone: null, locale: null, notificationPrefs: null, avatarSource: 'google', googlePictureUrl: null, avatarKey: null }),
      updateDate: 'updatedAt',
      deleteDate: 'deletedAt',
    })
    .define(UserEntitlement, {
      primary: ['id'],
      unique: [['userId', 'entitlement']],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), productId: null, expiresAt: null, willRenew: null, lastEventId: null }),
      updateDate: 'updatedAt',
    })
    .define(BillingEvent, {
      primary: ['eventId'],
      generate: () => ({ processedAt: new Date(), appUserId: null }),
    })
    .define(RefreshToken, {
      primary: ['id'],
      unique: [['tokenHash']],
      generate: () => ({ id: randomUUID(), createdAt: new Date() }),
    })
    .define(Trip, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), itineraryVersion: 0 }),
      updateDate: 'updatedAt',
    })
    .define(TripMember, {
      primary: ['tripId', 'userId'],
      // Like UQ_trip_members_one_owner (a partial unique index).
      unique: [{ name: 'UQ_trip_members_one_owner', columns: ['tripId'], where: (row) => row.role === 'owner' }],
      generate: () => ({ joinedAt: new Date() }),
      relations: tripRelation,
    })
    .define(TripInvite, {
      primary: ['id'],
      unique: [['tokenHash']],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), acceptedBy: null, acceptedAt: null, revokedAt: null }),
      relations: tripRelation,
    })
    .define(IdempotencyKey, {
      primary: ['userId', 'key'],
      generate: () => ({ createdAt: new Date(), status: 0, responseBody: null }),
      relations: { user: { entity: User, column: 'userId' } },
    })
    .define(TripRemoval, {
      primary: ['tripId', 'userId'],
      relations: tripRelation,
    });
}
