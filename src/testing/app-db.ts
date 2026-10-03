/** TEST ONLY: an `InMemoryDb` with the app tables (users, refresh_tokens, trips, trip_members, trip_invites, trip_removals). */
import { randomUUID } from 'node:crypto';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripInvite } from '../members/trip-invite.entity.js';
import { TripRemoval } from '../members/trip-removal.entity.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from '../auth/refresh-token.entity.js';
import { InMemoryDb } from './in-memory-db.js';

export function appDb(): InMemoryDb {
  const tripRelation = { trip: { entity: Trip, column: 'tripId' } };
  return new InMemoryDb()
    .define(User, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), deletedAt: null }),
      updateDate: 'updatedAt',
      deleteDate: 'deletedAt',
    })
    .define(RefreshToken, {
      primary: ['id'],
      unique: [['tokenHash']],
      generate: () => ({ id: randomUUID(), createdAt: new Date() }),
    })
    .define(Trip, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }),
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
    .define(TripRemoval, {
      primary: ['tripId', 'userId'],
      relations: tripRelation,
    });
}
