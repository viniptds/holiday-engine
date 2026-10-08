import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, In, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import type { Locale } from '../app-common/locale.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween, MAX_TRIP_DAYS } from '../trips/dto/date-rules.js';
import { TripMember } from './trip-member.entity.js';
import { TripScheduleHooks } from './trip-schedule-hooks.js';
import { TripActivity } from './trip-activity.js';
import { AppTripDto, TravelerProfile, TripRole } from './app-trips.types.js';
import { WizardService } from '../wizard/wizard.service.js';
import { CreateAppTripDto } from './dto/create-app-trip.dto.js';
import { UpdateAppTripDto } from './dto/update-app-trip.dto.js';
import { TravelerProfileInputDto } from './dto/traveler-profile.dto.js';
import { previewMembers, toAppTripDto, toMemberSummary } from './app-trip.mapper.js';

const tripNotFound = () => new AppError('NOT_FOUND', 'Trip not found');

/**
 * App trips. Every method is scoped by membership: a trip the user isn't a member of
 * behaves as not found. Inputs are expected to be validated with the DTOs first. Methods that
 * return trips take the request's `locale`, the language of the persona label.
 */
@Injectable()
export class AppTripsService {
  constructor(
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    private readonly wizard: WizardService,
    @Optional() private readonly scheduleHooks?: TripScheduleHooks,
    @Optional() private readonly activity?: TripActivity,
  ) {}

  /** Trips the user is a member of, by startDate ascending. */
  async list(user: AuthUser, locale: Locale): Promise<AppTripDto[]> {
    const memberships = await this.members.find({
      where: { userId: user.id },
      relations: { trip: true },
      order: { trip: { startDate: 'ASC', createdAt: 'ASC' } },
    });
    return this.present(memberships, locale);
  }

  /**
   * Creates the trip and the caller's owner membership in one transaction, and returns it in
   * `locale`. `inTransaction` runs inside it with the new trip, for callers that save related rows
   * atomically (AI confirm).
   */
  async create(
    user: AuthUser,
    data: CreateAppTripDto,
    locale: Locale,
    inTransaction?: (manager: EntityManager, trip: Trip) => Promise<void>,
  ): Promise<AppTripDto> {
    const travelerProfile = this.toTravelerProfile(data.travelerProfile);
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
          travelerProfile,
        }),
      );
      const member = await manager.save(manager.create(TripMember, { tripId: trip.id, userId: user.id, role: 'owner' }));
      member.trip = trip;
      await inTransaction?.(manager, trip);
      return member;
    });
    await this.activity?.emit({ type: 'trip.saved', tripId: membership.tripId, userId: user.id });
    const [dto] = await this.present([membership], locale);
    return dto;
  }

  async get(user: AuthUser, tripId: string, locale: Locale): Promise<AppTripDto> {
    const [dto] = await this.present([await this.requireMembership(user, tripId)], locale);
    return dto;
  }

  /** Owners and editors only. Omitted fields are kept; null clears the nullable ones. */
  async update(user: AuthUser, tripId: string, data: UpdateAppTripDto, locale: Locale): Promise<AppTripDto> {
    const membership = await this.requireMembership(user, tripId, ['owner', 'editor']);
    const trip = membership.trip!;
    const before = { startDate: trip.startDate, endDate: trip.endDate };
    if (data.destination !== undefined && data.destination !== trip.destination) {
      trip.destination = data.destination;
      // A new destination is resolved again (country and city, for the explorer achievements).
      trip.countryCode = null;
      trip.cityPlaceId = null;
    }
    if (data.startDate !== undefined) trip.startDate = data.startDate;
    if (data.endDate !== undefined) trip.endDate = data.endDate;
    if (data.notes !== undefined) trip.notes = data.notes;
    if (data.story !== undefined) trip.story = data.story;
    if (data.partyType !== undefined) trip.partyType = data.partyType;
    if (data.partySize !== undefined) trip.partySize = data.partySize;
    if (data.travelerProfile !== undefined) trip.travelerProfile = this.toTravelerProfile(data.travelerProfile);
    // Rewrites a legacy persona label (rows saved before keys were stored) to its key on save.
    else trip.travelerProfile = this.wizard.normalizeProfile(trip.travelerProfile ?? null);

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

    // The itinerary version only changes under the trip row lock (ItineraryService); this trip was
    // loaded without it, so its value may be stale and must not be written back.
    (trip as Partial<Trip>).itineraryVersion = undefined;
    const datesChanged = trip.startDate !== before.startDate || trip.endDate !== before.endDate;
    if (datesChanged && this.scheduleHooks?.any) {
      // Days that no longer exist lose their places (to Unplanned) in the same transaction.
      membership.trip = await this.trips.manager.transaction(async (manager) => {
        await manager.findOne(Trip, { where: { id: trip.id }, lock: { mode: 'pessimistic_write' } });
        const saved = await manager.save(trip);
        await this.scheduleHooks!.datesChanged(manager, saved);
        return saved;
      });
    } else {
      membership.trip = await this.trips.save(trip);
    }
    await this.activity?.emit({ type: 'trip.saved', tripId: trip.id, userId: user.id });
    const [dto] = await this.present([membership], locale);
    return dto;
  }

  /** Owner only. Members and suggested events go with the trip (ON DELETE CASCADE). */
  async delete(user: AuthUser, tripId: string): Promise<void> {
    const membership = await this.requireMembership(user, tripId, ['owner']);
    await this.trips.delete({ id: membership.tripId });
  }

  /** Validates a client profile against the question set and computes its persona (VALIDATION if invalid). */
  private toTravelerProfile(input: TravelerProfileInputDto | null | undefined): TravelerProfile | null {
    return input ? this.wizard.buildProfile(input) : null;
  }

  /**
   * The user's membership of the trip, with the trip loaded. Not a member (or a malformed id)
   * → NOT_FOUND; a member without one of `roles` → FORBIDDEN.
   */
  async requireMembership(user: AuthUser, tripId: string, roles?: TripRole[]): Promise<TripMember> {
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
  private async present(memberships: TripMember[], locale: Locale): Promise<AppTripDto[]> {
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
        this.wizard.presentProfile(membership.trip!.travelerProfile ?? null, locale),
      );
    });
  }
}
