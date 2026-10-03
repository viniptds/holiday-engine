import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween, MAX_TRIP_DAYS } from '../trips/dto/date-rules.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripDto, TravelerProfile, TripRole } from './app-trips.types.js';
import { CreateAppTripDto } from './dto/create-app-trip.dto.js';
import { UpdateAppTripDto } from './dto/update-app-trip.dto.js';
import { TravelerProfileInputDto } from './dto/traveler-profile.dto.js';
import { previewMembers, toAppTripDto, toMemberSummary } from './app-trip.mapper.js';

const tripNotFound = () => new AppError('NOT_FOUND', 'Trip not found');

// Persona is computed against the question set in B2; stored as null until then.
const toTravelerProfile = (input: TravelerProfileInputDto | null | undefined): TravelerProfile | null =>
  input ? { questionSetVersion: input.questionSetVersion, answers: input.answers, persona: null } : null;

/**
 * App trips. Every method is scoped by membership: a trip the user isn't a member of
 * behaves as not found. Inputs are expected to be validated with the DTOs first.
 */
@Injectable()
export class AppTripsService {
  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
  ) {}

  /** Trips the user is a member of, by startDate ascending. */
  async list(user: AuthUser): Promise<AppTripDto[]> {
    const memberships = await this.members.find({
      where: { userId: user.id },
      relations: { trip: true },
      order: { trip: { startDate: 'ASC', createdAt: 'ASC' } },
    });
    return this.present(memberships);
  }

  /** Creates the trip and the caller's owner membership in one transaction. */
  async create(user: AuthUser, data: CreateAppTripDto): Promise<AppTripDto> {
    const membership = await this.trips.manager.transaction(async (manager) => {
      const trip = await manager.save(
        manager.create(Trip, {
          provider: null,
          chatId: null,
          ownerUserId: user.id,
          destination: data.destination,
          startDate: data.startDate,
          endDate: data.endDate,
          notes: data.notes ?? null,
          story: data.story ?? null,
          partyType: data.partyType ?? null,
          partySize: data.partySize ?? null,
          travelerProfile: toTravelerProfile(data.travelerProfile),
        }),
      );
      const member = await manager.save(manager.create(TripMember, { tripId: trip.id, userId: user.id, role: 'owner' }));
      member.trip = trip;
      return member;
    });
    const [dto] = await this.present([membership]);
    return dto;
  }

  async get(user: AuthUser, tripId: string): Promise<AppTripDto> {
    const [dto] = await this.present([await this.membership(user, tripId)]);
    return dto;
  }

  /** Owners and editors only. Omitted fields are kept; null clears the nullable ones. */
  async update(user: AuthUser, tripId: string, data: UpdateAppTripDto): Promise<AppTripDto> {
    const membership = await this.membership(user, tripId, ['owner', 'editor']);
    const trip = membership.trip!;
    if (data.destination !== undefined) trip.destination = data.destination;
    if (data.startDate !== undefined) trip.startDate = data.startDate;
    if (data.endDate !== undefined) trip.endDate = data.endDate;
    if (data.notes !== undefined) trip.notes = data.notes;
    if (data.story !== undefined) trip.story = data.story;
    if (data.partyType !== undefined) trip.partyType = data.partyType;
    if (data.partySize !== undefined) trip.partySize = data.partySize;
    if (data.travelerProfile !== undefined) trip.travelerProfile = toTravelerProfile(data.travelerProfile);

    // The DTO checks the dates when both are sent; this covers one date against the stored other.
    const dateField = data.endDate !== undefined ? 'endDate' : 'startDate';
    if (trip.endDate < trip.startDate) {
      throw new AppError('VALIDATION', 'Some fields are invalid', {
        [dateField]: 'endDate must be on or after startDate',
      });
    }
    if (daysBetween(trip.startDate, trip.endDate) > MAX_TRIP_DAYS) {
      throw new AppError('VALIDATION', 'Some fields are invalid', {
        [dateField]: `endDate must be at most ${MAX_TRIP_DAYS} days after startDate`,
      });
    }

    membership.trip = await this.trips.save(trip);
    const [dto] = await this.present([membership]);
    return dto;
  }

  /** Owner only. Members and suggested events go with the trip (ON DELETE CASCADE). */
  async delete(user: AuthUser, tripId: string): Promise<void> {
    const membership = await this.membership(user, tripId, ['owner']);
    await this.trips.delete({ id: membership.tripId });
  }

  /**
   * The user's membership of the trip, with the trip loaded. Not a member (or a malformed id)
   * → NOT_FOUND; a member without one of `roles` → FORBIDDEN.
   */
  private async membership(user: AuthUser, tripId: string, roles?: TripRole[]): Promise<TripMember> {
    // Non-UUID ids would make Postgres throw; treat them as not found.
    if (!isUUID(tripId, '4')) throw tripNotFound();
    const membership = await this.members.findOne({
      where: { tripId, userId: user.id },
      relations: { trip: true },
    });
    if (!membership?.trip) throw tripNotFound();
    if (roles && !roles.includes(membership.role)) {
      throw new AppError('FORBIDDEN', `A trip ${membership.role} can't do this`);
    }
    return membership;
  }

  /** Builds the `Trip` responses for the given memberships (trip loaded), keeping their order. */
  private async present(memberships: TripMember[]): Promise<AppTripDto[]> {
    if (memberships.length === 0) return [];
    const tripIds = [...new Set(memberships.map((m) => m.tripId))];
    const all = await this.members.find({ where: { tripId: In(tripIds) } });

    const byTrip = new Map<string, TripMember[]>();
    for (const member of all) {
      const list = byTrip.get(member.tripId);
      if (list) list.push(member);
      else byTrip.set(member.tripId, [member]);
    }
    const previews = new Map([...byTrip].map(([id, members]) => [id, previewMembers(members)]));

    const userIds = [...new Set([...previews.values()].flat().map((m) => m.userId))];
    const profiles = await this.users.getProfiles(userIds);

    return memberships.map((membership) => {
      const preview = previews.get(membership.tripId) ?? [];
      return toAppTripDto(
        membership.trip!,
        membership.role,
        preview.map((m) => toMemberSummary(m, profiles.get(m.userId))),
        byTrip.get(membership.tripId)?.length ?? 0,
      );
    });
  }
}
