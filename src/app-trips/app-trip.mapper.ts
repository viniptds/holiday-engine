import { Trip } from '../trips/trip.entity.js';
import type { UserProfile } from '../app-common/auth-user.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripDto, MEMBER_PREVIEW_SIZE, MemberSummary, TravelerProfile, TripRole } from './app-trips.types.js';

/** Owner first, then by join date (oldest first); user id breaks ties so the order is stable. */
export function compareMembers(a: TripMember, b: TripMember): number {
  const byOwner = Number(a.role !== 'owner') - Number(b.role !== 'owner');
  if (byOwner !== 0) return byOwner;
  const byJoined = new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
  return byJoined || a.userId.localeCompare(b.userId);
}

/** The first `MEMBER_PREVIEW_SIZE` members of a trip, owner first. */
export function previewMembers(members: TripMember[]): TripMember[] {
  return [...members].sort(compareMembers).slice(0, MEMBER_PREVIEW_SIZE);
}

export function toMemberSummary(member: TripMember, profile: UserProfile | undefined): MemberSummary {
  return {
    userId: member.userId,
    // Shouldn't happen (members are removed with their user); keeps the response well-formed if it does.
    displayName: profile?.displayName ?? 'Traveler',
    avatarUrl: profile?.avatarUrl ?? null,
    role: member.role,
  };
}

/**
 * Maps a trip to the app API `Trip` shape. `travelerProfile` is the trip's profile as returned
 * (persona label in the request's language), not the stored one.
 */
export function toAppTripDto(
  trip: Trip,
  myRole: TripRole,
  members: MemberSummary[],
  memberCount: number,
  travelerProfile: TravelerProfile | null,
): AppTripDto {
  return {
    id: trip.id,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    notes: trip.notes ?? null,
    story: trip.story ?? null,
    partyType: trip.partyType ?? null,
    partySize: trip.partySize ?? null,
    travelerProfile,
    myRole,
    members,
    memberCount,
    createdAt: new Date(trip.createdAt).toISOString(),
    updatedAt: new Date(trip.updatedAt).toISOString(),
  };
}
