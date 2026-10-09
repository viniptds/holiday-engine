import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import type { AuthUser } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { RateWindow } from '../app-common/rate-window.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, localIsoDate } from '../app-common/timezone.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import type { TripActivityEvent } from '../app-trips/trip-activity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { DestinationResolver } from '../media/destination-resolver.js';
import { MomentsService } from '../moments/moments.service.js';
import type { StorageRequestContext } from '../moments/storage/object-storage.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween } from '../trips/dto/date-rules.js';
import { User } from '../users/user.entity.js';
import { UserAchievement } from './user-achievement.entity.js';
import {
  CITY_MILESTONES,
  COUNTRY_MILESTONES,
  DAY_COMPLETED_PREFIX,
  EVENT_RATE_LIMIT,
  FIRST_COLLAGE_SHARED,
  MAX_LAZY_RESOLVES,
  MAX_LAZY_TRIPS,
  MAX_THUMBS_PER_DAY,
  MOMENT_MILESTONES,
  PLANNING_KEYS,
  TRIP_FINISHED,
  TRIP_STARTED,
} from './achievements.types.js';
import { SKIPPABLE_KEYS } from './achievements.types.js';
import type { AchievementDto, JourneyDto, JourneyMember, JourneyNode, JourneyNodeStatus, PlanningKey } from './achievements.types.js';
import { TripJourneySkip } from './trip-journey-skip.entity.js';
import { AppError } from '../app-common/app-error.js';
import { JOURNEY_TITLES } from './journey-titles.js';

/** The ISO date `n - 1` days after `start`. */
const dayDate = (start: string, n: number) => new Date(Date.parse(`${start}T00:00:00Z`) + (n - 1) * 86_400_000).toISOString().slice(0, 10);

/** What a trip has, independent of who looks at it. */
type TripFacts = { trip: Trip; days: number; planning: Record<PlanningKey, boolean>; momentDays: Set<number> };

const isSkippable = (key: string) => (SKIPPABLE_KEYS as readonly string[]).includes(key);
function requireSkippable(key: string): void {
  if (!isSkippable(key)) {
    throw new AppError('VALIDATION', 'Some fields are invalid', { key: `Only ${SKIPPABLE_KEYS.join(' and ')} can be skipped` }, { reason: 'STEP_NOT_SKIPPABLE' });
  }
}

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505';

/**
 * Achievements and the Journey (docs/app-moments-spec.md §3). Computed by the engine after the
 * writes that matter (TripActivity) and lazily on reads for the date-based ones. Unlocking is
 * idempotent: (userId, key, tripId) is unique. Per-trip keys go to every current member.
 */
@Injectable()
export class AchievementsService {
  private readonly logger = new Logger(AchievementsService.name);
  private readonly events = new RateWindow(EVENT_RATE_LIMIT.max, EVENT_RATE_LIMIT.windowMs, 'Too many achievement events. Please wait a little.');

  constructor(
    @InjectRepository(UserAchievement) private readonly achievements: Repository<UserAchievement>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @InjectRepository(TripPlace) private readonly places: Repository<TripPlace>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(TripJourneySkip) private readonly skips: Repository<TripJourneySkip>,
    private readonly appTrips: AppTripsService,
    private readonly moments: MomentsService,
    private readonly destinations: DestinationResolver,
    @Optional() private readonly activity?: TripActivity,
  ) {}

  /** TripActivity listener: re-checks what the write can have changed. */
  async onActivity(event: TripActivityEvent, now = new Date()): Promise<void> {
    switch (event.type) {
      case 'trip.saved': {
        const trip = await this.trips.findOne({ where: { id: event.tripId } });
        if (trip) await this.destinations.ensure(trip);
        await this.evaluateTrip(event.tripId, now);
        for (const member of await this.members.find({ where: { tripId: event.tripId } })) await this.evaluateUser(member.userId, now);
        return;
      }
      case 'trip.itinerary':
        await this.evaluateTrip(event.tripId, now);
        return;
      case 'member.joined':
        await this.evaluateTrip(event.tripId, now);
        await this.evaluateUser(event.userId, now);
        return;
      case 'moment.completed':
        if (event.tripId) await this.evaluateTrip(event.tripId, now);
        await this.evaluateUser(event.userId, now);
        return;
      default:
        return;
    }
  }

  /** `GET /me/achievements`: the date-based ones are evaluated first. */
  async list(user: AuthUser, now = new Date()): Promise<AchievementDto[]> {
    await this.evaluateLazily(user.id, now);
    const rows = await this.achievements.find({ where: { userId: user.id }, order: { unlockedAt: 'ASC' } });
    return rows.map(toDto);
  }

  /** `POST /achievements/events` (collage_shared): the caller must be a member of the trip. */
  async event(user: AuthUser, tripId: string): Promise<AchievementDto[]> {
    await this.appTrips.requireMembership(user, tripId);
    this.events.take(user.id);
    await this.unlock(user.id, FIRST_COLLAGE_SHARED, null);
    const rows = await this.achievements.find({ where: { userId: user.id }, order: { unlockedAt: 'ASC' } });
    return rows.map(toDto);
  }

  /** `POST /achievements/seen`: marks the caller's own achievements seen (unknown ones are ignored). */
  async markSeen(user: AuthUser, keys: { key: string; tripId: string | null }[], now = new Date()): Promise<void> {
    for (const { key, tripId } of keys) {
      await this.achievements.update({ userId: user.id, key, tripId: tripId ? tripId.toLowerCase() : IsNull(), seenAt: IsNull() }, { seenAt: now });
    }
  }

  /** `GET /trips/:id/journey` (members). Titles in `locale`; day dates in the caller's time zone. */
  async journey(
    user: AuthUser,
    tripId: string,
    locale: Locale,
    timeZone: string,
    context: StorageRequestContext,
    now = new Date(),
  ): Promise<JourneyDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    return this.buildJourney(user, trip!, locale, timeZone, context, now);
  }

  /** Owners and editors skip a skippable step for the whole trip. Repeats are no-ops. Never awards anything. */
  async skip(user: AuthUser, tripId: string, key: string, locale: Locale, timeZone: string, context: StorageRequestContext): Promise<JourneyDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    requireSkippable(key);
    if (!(await this.skips.findOne({ where: { tripId: trip!.id, key } }))) {
      try {
        await this.skips.insert({ tripId: trip!.id, key, skippedBy: user.id, skippedAt: new Date() });
      } catch (error) {
        // A concurrent skip of the same step won.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    return this.buildJourney(user, trip!, locale, timeZone, context);
  }

  /** Undoes a skip (owners and editors). Unskipping something not skipped is a no-op. */
  async unskip(user: AuthUser, tripId: string, key: string, locale: Locale, timeZone: string, context: StorageRequestContext): Promise<JourneyDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    requireSkippable(key);
    await this.skips.delete({ tripId: trip!.id, key });
    return this.buildJourney(user, trip!, locale, timeZone, context);
  }

  private async buildJourney(user: AuthUser, trip: Trip, locale: Locale, timeZone: string, context: StorageRequestContext, now = new Date()): Promise<JourneyDto> {
    const facts = await this.tripFacts(trip);
    await this.unlockTrip(facts, [{ userId: user.id, zone: timeZone }], now);

    const titles = JOURNEY_TITLES[locale];
    const today = localIsoDate(zoneOr(timeZone), now);
    const skipRows = await this.skips.find({ where: { tripId: trip.id } });
    const skips = new Map(skipRows.map((s) => [s.key, s]));
    const skippers = await this.skippers(trip.id, skipRows);
    /** done beats skipped; anything else open is decided below (current/todo). */
    const state = (key: string, done: boolean, locked = false): JourneyNodeStatus | 'open' =>
      done ? 'done' : skips.has(key) && isSkippable(key) ? 'skipped' : locked ? 'locked' : 'open';
    type Draft = Omit<JourneyNode, 'status'> & { status: JourneyNodeStatus | 'open' };

    const drafts: Draft[] = PLANNING_KEYS.map((key) => ({
      kind: 'milestone' as const,
      key,
      title: titles[key],
      status: state(key, facts.planning[key]),
      skippable: isSkippable(key),
    }));
    const thumbs = await this.moments.thumbsByDay(facts.trip.id, MAX_THUMBS_PER_DAY, context);
    for (let n = 1; n <= facts.days; n++) {
      const date = dayDate(facts.trip.startDate, n);
      const key = `${DAY_COMPLETED_PREFIX}${n}`;
      // A day is done once it has a photo (any order); a future day is locked until it comes.
      drafts.push({ kind: 'day', key, title: titles.day(n), day: n, date, status: state(key, facts.momentDays.has(n), date > today), skippable: false, momentThumbs: thumbs.get(n) ?? [] });
    }
    drafts.push({ kind: 'milestone', key: TRIP_FINISHED, title: titles.trip_finished, status: state(TRIP_FINISHED, today > facts.trip.endDate, true), skippable: false });

    let current = false;
    const nodes: JourneyNode[] = drafts.map((draft) => {
      let status = draft.status;
      if (status === 'open') {
        status = current ? 'todo' : 'current';
        current = true;
      }
      const skipper = status === 'skipped' ? skippers.get(skips.get(draft.key)!.skippedBy ?? '') : undefined;
      return { ...draft, status, ...(skipper ? { skippedBy: skipper } : {}) };
    });
    const resolved = nodes.filter((n) => n.status === 'done' || n.status === 'skipped').length;

    const rows = await this.achievements.find({ where: { userId: user.id, tripId: facts.trip.id }, order: { unlockedAt: 'ASC' } });
    return { nodes, achievements: rows.map(toDto), progress: { resolved, total: nodes.length } };
  }

  /** The members who skipped steps, as MemberSummary-like values (role null if they left). */
  private async skippers(tripId: string, rows: TripJourneySkip[]): Promise<Map<string, JourneyMember>> {
    const ids = [...new Set(rows.map((r) => r.skippedBy).filter((id): id is string => !!id))];
    if (ids.length === 0) return new Map();
    const [users, members] = await Promise.all([
      this.users.find({ where: { id: In(ids) } }),
      this.members.find({ where: { tripId, userId: In(ids) } }),
    ]);
    const roles = new Map(members.map((m) => [m.userId, m.role]));
    return new Map(users.map((u) => [u.id, { userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, role: roles.get(u.id) ?? null }]));
  }

  /** Re-checks one trip for all its current members (or only `onlyUserIds`). */
  async evaluateTrip(tripId: string, now = new Date(), onlyUserIds?: string[]): Promise<void> {
    const trip = await this.trips.findOne({ where: { id: tripId } });
    if (!trip || !trip.ownerUserId) return;
    const members = await this.members.find({ where: onlyUserIds ? { tripId, userId: In(onlyUserIds) } : { tripId } });
    if (members.length === 0) return;
    const zones = await this.zones(members.map((m) => m.userId));
    await this.unlockTrip(await this.tripFacts(trip), members.map((m) => ({ userId: m.userId, zone: zones.get(m.userId) ?? DEFAULT_TIMEZONE })), now);
  }

  /** Per-user keys: moment counts and the explorer counts (trips that have started). */
  async evaluateUser(userId: string, now = new Date()): Promise<void> {
    const ready = await this.moments.countReady(userId);
    for (const [threshold, key] of MOMENT_MILESTONES) if (ready >= threshold) await this.unlock(userId, key, null);

    const zone = (await this.zones([userId])).get(userId) ?? DEFAULT_TIMEZONE;
    const today = localIsoDate(zone, now);
    const memberships = await this.members.find({ where: { userId }, relations: { trip: true } });
    const started = memberships.map((m) => m.trip).filter((t): t is Trip => !!t && t.startDate <= today);
    let resolves = 0;
    for (const trip of started) {
      if (trip.cityPlaceId || resolves >= MAX_LAZY_RESOLVES) continue;
      resolves++;
      await this.destinations.ensure(trip);
    }
    const countries = new Set(started.map((t) => t.countryCode).filter(Boolean)).size;
    const cities = new Set(started.map((t) => t.cityPlaceId).filter(Boolean)).size;
    for (const [threshold, key] of COUNTRY_MILESTONES) if (countries >= threshold) await this.unlock(userId, key, null);
    for (const [threshold, key] of CITY_MILESTONES) if (cities >= threshold) await this.unlock(userId, key, null);
  }


  /** Date-based keys on reads: the user's trips that have started and that they haven't seen finish. */
  private async evaluateLazily(userId: string, now: Date): Promise<void> {
    const zone = (await this.zones([userId])).get(userId) ?? DEFAULT_TIMEZONE;
    const today = localIsoDate(zone, now);
    const finished = new Set(
      (await this.achievements.find({ where: { userId, key: TRIP_FINISHED } })).map((a) => a.tripId),
    );
    const memberships = await this.members.find({ where: { userId }, relations: { trip: true } });
    const due = memberships
      .map((m) => m.trip)
      .filter((t): t is Trip => !!t && t.startDate <= today && !finished.has(t.id))
      .slice(0, MAX_LAZY_TRIPS);
    for (const trip of due) await this.evaluateTrip(trip.id, now, [userId]);
    await this.evaluateUser(userId, now);
  }

  private async tripFacts(trip: Trip): Promise<TripFacts> {
    const days = daysBetween(trip.startDate, trip.endDate) + 1;
    const [places, memberCount, momentDays] = await Promise.all([
      this.places.find({ where: { tripId: trip.id } }),
      this.members.count({ where: { tripId: trip.id } }),
      this.moments.readyDays(trip.id),
    ]);
    const plannedDays = new Set(places.map((p) => p.day).filter((d): d is number => d != null && d >= 1 && d <= days));
    return {
      trip,
      days,
      planning: {
        trip_created: true,
        first_place: places.length > 0,
        all_days_planned: plannedDays.size === days,
        first_member_joined: memberCount >= 2,
      },
      momentDays,
    };
  }

  private async unlockTrip(facts: TripFacts, members: { userId: string; zone: string }[], now: Date): Promise<void> {
    const { trip } = facts;
    for (const { userId, zone } of members) {
      const today = localIsoDate(zoneOr(zone), now);
      const keys: string[] = PLANNING_KEYS.filter((key) => facts.planning[key]);
      if (today >= trip.startDate) keys.push(TRIP_STARTED);
      for (let n = 1; n <= facts.days; n++) if (facts.momentDays.has(n)) keys.push(`${DAY_COMPLETED_PREFIX}${n}`);
      if (today > trip.endDate) keys.push(TRIP_FINISHED);
      for (const key of keys) await this.unlock(userId, key, trip.id);
    }
  }

  /** Inserts the achievement unless it's there; a concurrent insert of the same one is fine. */
  private async unlock(userId: string, key: string, tripId: string | null): Promise<void> {
    if (await this.achievements.findOne({ where: { userId, key, tripId: tripId ?? IsNull() } })) return;
    try {
      // Its own statement (no transaction): a duplicate fails only this insert.
      await this.achievements.insert({ userId, key, tripId, unlockedAt: new Date(), seenAt: null });
      this.logger.log(`User ${userId} unlocked ${key}${tripId ? ` on trip ${tripId}` : ''}`);
      await this.activity?.emit({ type: 'achievement.unlocked', tripId, userId, key });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  private async zones(userIds: string[]): Promise<Map<string, string>> {
    const rows = userIds.length ? await this.users.find({ where: { id: In(userIds) } }) : [];
    return new Map(rows.map((u) => [u.id, zoneOr(u.timezone)]));
  }
}

const zoneOr = (zone: string | null | undefined) => (isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE);

function toDto(row: UserAchievement): AchievementDto {
  return { key: row.key, tripId: row.tripId ?? null, unlockedAt: new Date(row.unlockedAt).toISOString(), seen: row.seenAt != null };
}
