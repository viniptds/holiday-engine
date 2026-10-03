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
import { MemberDto } from './members.types.js';

const memberNotFound = () => new AppError('NOT_FOUND', 'Member not found');

/** What `handleUserDeleted` did, for logging and tests. */
export type UserDeletionResult = { deletedTripIds: string[]; transferred: { tripId: string; newOwnerId: string }[] };

/**
 * Trip members. Access goes through `AppTripsService.requireMembership`: non-members get
 * NOT_FOUND, members without the role FORBIDDEN. A trip always has exactly one owner.
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
   * Owner only. `owner` transfers ownership (the old owner becomes editor) in one transaction.
   * The owner can't change their own role any other way.
   */
  async updateRole(user: AuthUser, tripId: string, targetId: string, role: TripRole): Promise<MemberDto> {
    await this.appTrips.requireMembership(user, tripId, ['owner']);
    const userId = this.parseUserId(targetId);

    if (userId === user.id) {
      if (role !== 'owner') {
        throw new AppError('CONFLICT', "The owner can't change their own role; transfer ownership instead");
      }
    } else if (role === 'owner') {
      await this.members.manager.transaction((manager) => this.transferOwnership(manager, tripId, user.id, userId));
    } else {
      const { affected } = await this.members.update({ tripId, userId, role: Not('owner') }, { role });
      if (!affected) throw memberNotFound();
    }

    const member = await this.members.findOne({ where: { tripId, userId } });
    if (!member) throw memberNotFound();
    const [dto] = await this.present([member]);
    return dto;
  }

  /**
   * `me` (or the caller's own id) leaves; otherwise the owner removes a member. The owner can't
   * leave or remove themselves (CONFLICT): they transfer ownership first. The departing member's
   * unused invites for the trip are revoked in the same transaction.
   */
  async remove(user: AuthUser, tripId: string, target: string): Promise<void> {
    const membership = await this.appTrips.requireMembership(user, tripId);
    const self = target === 'me' || target.toLowerCase() === user.id;
    if (self && membership.role === 'owner') {
      throw new AppError('CONFLICT', "The owner can't leave the trip; transfer ownership first");
    }
    if (!self && membership.role !== 'owner') throw new AppError('FORBIDDEN', `A trip ${membership.role} can't do this`);
    const userId = self ? user.id : this.parseUserId(target);

    await this.members.manager.transaction(async (manager) => {
      const { affected } = await manager.delete(TripMember, { tripId, userId });
      if (!affected) throw memberNotFound();
      await manager.update(
        TripInvite,
        { tripId, createdBy: userId, revokedAt: IsNull(), acceptedAt: IsNull() },
        { revokedAt: new Date() },
      );
    });
  }

  /**
   * Account deletion (wired to the users module's deletion hooks at G1). In one transaction:
   * trips the user is the only member of are deleted; shared trips they own pass to the
   * longest-standing editor, or else the longest-standing member; then their memberships are
   * removed and their pending invites revoked.
   */
  handleUserDeleted(userId: string): Promise<UserDeletionResult> {
    return this.members.manager.transaction(async (manager) => {
      const result: UserDeletionResult = { deletedTripIds: [], transferred: [] };
      const owned = await manager.find(TripMember, { where: { userId, role: 'owner' } });
      for (const { tripId } of owned) {
        const others = await manager.find(TripMember, {
          where: { tripId, userId: Not(userId) },
          order: { joinedAt: 'ASC', userId: 'ASC' },
        });
        if (others.length === 0) {
          await manager.delete(Trip, { id: tripId });
          result.deletedTripIds.push(tripId);
          continue;
        }
        const successor = others.find((m) => m.role === 'editor') ?? others[0];
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
    });
  }

  private async transferOwnership(manager: EntityManager, tripId: string, ownerId: string, newOwnerId: string) {
    // Lock both rows and re-check, so two concurrent transfers can't both succeed.
    const lock = { mode: 'pessimistic_write' } as const;
    const owner = await manager.findOne(TripMember, { where: { tripId, userId: ownerId }, lock });
    if (owner?.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the owner can transfer ownership');
    const next = await manager.findOne(TripMember, { where: { tripId, userId: newOwnerId }, lock });
    if (!next) throw memberNotFound();
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
