import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, IsNull, Not, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { compareMembers, toMemberSummary } from '../app-trips/app-trip.mapper.js';
import type { TripRole } from '../app-trips/app-trips.types.js';
import { TripInvite } from './trip-invite.entity.js';
import { TripRemoval } from './trip-removal.entity.js';
import { MemberDto } from './members.types.js';

const memberNotFound = () => new AppError('NOT_FOUND', 'Member not found');
const tripNotFound = () => new AppError('NOT_FOUND', 'Trip not found');
const LOCK = { mode: 'pessimistic_write' } as const;

/** What `handleUserDeleted` did, for logging and tests. */
export type UserDeletionResult = { deletedTripIds: string[]; transferred: { tripId: string; newOwnerId: string }[] };

const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown })?.code === '23505' ||
  (error as { driverError?: { code?: unknown } })?.driverError?.code === '23505';

/**
 * Runs a membership transaction. A unique violation (two owners, from a change that raced this
 * one past the row locks) becomes CONFLICT instead of a 500.
 */
async function conflictOnRace<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError('CONFLICT', 'The trip changed meanwhile; please try again');
    throw error;
  }
}

/** Revokes the member's unused invites for the trip (they left, were removed or were demoted to viewer). */
async function revokeInvitesBy(manager: EntityManager, tripId: string, userId: string): Promise<void> {
  await manager.update(
    TripInvite,
    { tripId, createdBy: userId, revokedAt: IsNull(), acceptedAt: IsNull() },
    { revokedAt: new Date() },
  );
}

/**
 * Trip members. Access goes through `AppTripsService.requireMembership`: non-members get
 * NOT_FOUND, members without the role FORBIDDEN. A trip always has exactly one owner, which the
 * database also enforces (UQ_trip_members_one_owner): every change re-reads and locks the acting
 * member's row inside its transaction, so concurrent changes are checked against the latest roles.
 */
@Injectable()
export class MembersService {
  constructor(
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    private readonly appTrips: AppTripsService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
  ) {}

  /** Every member, owner first, then by join date. */
  async list(user: AuthUser, tripId: string): Promise<MemberDto[]> {
    await this.appTrips.requireMembership(user, tripId);
    const members = (await this.members.find({ where: { tripId } })).sort(compareMembers);
    return this.present(members);
  }

  /**
   * Owner only. `owner` transfers ownership (the old owner becomes editor). Demoting someone to
   * viewer also revokes their unused invites. The owner can't change their own role any other way.
   */
  async updateRole(user: AuthUser, tripId: string, targetId: string, role: TripRole): Promise<MemberDto> {
    await this.appTrips.requireMembership(user, tripId, ['owner']);
    const userId = this.parseUserId(targetId);

    if (userId === user.id) {
      if (role !== 'owner') {
        throw new AppError('CONFLICT', "The owner can't change their own role; transfer ownership instead");
      }
    } else {
      await conflictOnRace(() =>
        this.members.manager.transaction(async (manager) => {
          await this.lockActor(manager, tripId, user.id, 'owner');
          if (role === 'owner') {
            await this.transferOwnership(manager, tripId, user.id, userId);
            return;
          }
          const target = await manager.findOne(TripMember, { where: { tripId, userId }, lock: LOCK });
          // The actor is the owner, so the target isn't.
          if (!target || target.role === 'owner') throw memberNotFound();
          await manager.update(TripMember, { tripId, userId }, { role });
          if (role === 'viewer') await revokeInvitesBy(manager, tripId, userId);
        }),
      );
    }

    const member = await this.members.findOne({ where: { tripId, userId } });
    if (!member) throw memberNotFound();
    const [dto] = await this.present([member]);
    return dto;
  }

  /**
   * `me` (or the caller's own id) leaves; otherwise the owner removes a member, which is recorded so
   * they can't rejoin through a link invite. The owner can't leave or remove themselves (CONFLICT):
   * they transfer ownership first. The departing member's unused invites for the trip are revoked in
   * the same transaction.
   */
  async remove(user: AuthUser, tripId: string, target: string): Promise<void> {
    const membership = await this.appTrips.requireMembership(user, tripId);
    const self = target === 'me' || target.toLowerCase() === user.id;
    if (self && membership.role === 'owner') throw ownerCantLeave();
    if (!self && membership.role !== 'owner') throw new AppError('FORBIDDEN', `A trip ${membership.role} can't do this`);
    const userId = self ? user.id : this.parseUserId(target);

    await conflictOnRace(() =>
      this.members.manager.transaction(async (manager) => {
        // Re-check the caller's role under a lock: an ownership transfer may have committed since.
        const actor = await this.lockActor(manager, tripId, user.id);
        if (self && actor.role === 'owner') throw ownerCantLeave();
        if (!self && actor.role !== 'owner') throw new AppError('FORBIDDEN', `A trip ${actor.role} can't do this`);

        const { affected } = await manager.delete(TripMember, { tripId, userId, role: Not('owner') });
        if (!affected) throw memberNotFound();
        await revokeInvitesBy(manager, tripId, userId);
        if (!self) {
          await manager.delete(TripRemoval, { tripId, userId });
          await manager.insert(TripRemoval, { tripId, userId, removedBy: user.id, removedAt: new Date() });
        }
      }),
    );
  }

  /**
   * Account deletion (wired to the users module's deletion hooks at G1). In one transaction:
   * trips the user is the only member of are deleted; shared trips they own pass to the
   * longest-standing editor, or else the longest-standing member; then their memberships are
   * removed and their pending invites revoked. Their owner rows are locked first, so an ownership
   * transfer running at the same time is either seen as done or waits.
   */
  handleUserDeleted(userId: string): Promise<UserDeletionResult> {
    return conflictOnRace(() =>
      this.members.manager.transaction(async (manager) => {
        const result: UserDeletionResult = { deletedTripIds: [], transferred: [] };
        const owned = await manager.find(TripMember, { where: { userId, role: 'owner' }, lock: LOCK });
        for (const { tripId } of owned) {
          const others = await manager.find(TripMember, {
            where: { tripId, userId: Not(userId) },
            order: { joinedAt: 'ASC', userId: 'ASC' },
            lock: LOCK,
          });
          if (others.length === 0) {
            await manager.delete(Trip, { id: tripId });
            result.deletedTripIds.push(tripId);
            continue;
          }
          const successor = others.find((m) => m.role === 'editor') ?? others[0];
          // The departing owner goes first: the trip can't have two owners, even for a moment.
          await manager.delete(TripMember, { tripId, userId });
          await manager.update(TripMember, { tripId, userId: successor.userId }, { role: 'owner' });
          await manager.update(Trip, { id: tripId }, { ownerUserId: successor.userId });
          result.transferred.push({ tripId, newOwnerId: successor.userId });
        }
        await manager.delete(TripMember, { userId });
        await manager.update(
          TripInvite,
          { createdBy: userId, revokedAt: IsNull(), acceptedAt: IsNull() },
          { revokedAt: new Date() },
        );
        return result;
      }),
    );
  }

  /**
   * Re-reads the acting member's row with a lock inside the transaction. Gone → NOT_FOUND (like a
   * non-member); not `role` (when given) → FORBIDDEN.
   */
  private async lockActor(manager: EntityManager, tripId: string, userId: string, role?: TripRole): Promise<TripMember> {
    const actor = await manager.findOne(TripMember, { where: { tripId, userId }, lock: LOCK });
    if (!actor) throw tripNotFound();
    if (role && actor.role !== role) throw new AppError('FORBIDDEN', `A trip ${actor.role} can't do this`);
    return actor;
  }

  /** Inside `updateRole`'s transaction, with the owner's row already locked and checked. */
  private async transferOwnership(manager: EntityManager, tripId: string, ownerId: string, newOwnerId: string) {
    const next = await manager.findOne(TripMember, { where: { tripId, userId: newOwnerId }, lock: LOCK });
    if (!next) throw memberNotFound();
    // Demote first: the trip can't have two owners, even for a moment.
    await manager.update(TripMember, { tripId, userId: ownerId }, { role: 'editor' });
    await manager.update(TripMember, { tripId, userId: newOwnerId }, { role: 'owner' });
    await manager.update(Trip, { id: tripId }, { ownerUserId: newOwnerId });
  }

  /** A path user id; anything but a v4 UUID is an unknown member. */
  private parseUserId(value: string): string {
    if (!isUUID(value, '4')) throw memberNotFound();
    return value.toLowerCase();
  }

  private async present(members: TripMember[]): Promise<MemberDto[]> {
    const profiles = await this.users.getProfiles([...new Set(members.map((m) => m.userId))]);
    return members.map((m) => ({
      ...toMemberSummary(m, profiles.get(m.userId)),
      joinedAt: new Date(m.joinedAt).toISOString(),
    }));
  }
}

const ownerCantLeave = () => new AppError('CONFLICT', "The owner can't leave the trip; transfer ownership first");
