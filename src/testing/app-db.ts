/** TEST ONLY: an `InMemoryDb` with the app tables (trips, trip_members, trip_invites). */
import { randomUUID } from 'node:crypto';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripInvite } from '../members/trip-invite.entity.js';
import { InMemoryDb } from './in-memory-db.js';

export function appDb(): InMemoryDb {
  const tripRelation = { trip: { entity: Trip, column: 'tripId' } };
  return new InMemoryDb()
    .define(Trip, {
      primary: ['id'],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date() }),
      updateDate: 'updatedAt',
    })
    .define(TripMember, {
      primary: ['tripId', 'userId'],
      generate: () => ({ joinedAt: new Date() }),
      relations: tripRelation,
    })
    .define(TripInvite, {
      primary: ['id'],
      unique: [['tokenHash']],
      generate: () => ({ id: randomUUID(), createdAt: new Date(), acceptedBy: null, acceptedAt: null, revokedAt: null }),
      relations: tripRelation,
    });
}
