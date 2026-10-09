import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, In, IsNull, LessThan, Repository } from 'typeorm';
import { AppError, conflict, paymentRequired } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { RateWindow } from '../app-common/rate-window.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, localIsoDate } from '../app-common/timezone.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { BillingService } from '../billing/billing.service.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween } from '../trips/dto/date-rules.js';
import { Moment } from './moment.entity.js';
import { CreateMomentDto } from './moments.dto.js';
import {
  MAX_UNASSIGNED_MOMENTS,
  PENDING_CLEANUP_BATCH,
  PENDING_CLEANUP_INTERVAL_MS,
  PENDING_MOMENT_TTL_MS,
  UPLOAD_RATE_LIMIT,
} from './moments.types.js';
import type { CreatedMomentDto, MomentDto } from './moments.types.js';
import { OBJECT_STORAGE, momentObjectKey } from './storage/object-storage.js';
import type { ObjectStorage, StorageRequestContext } from './storage/object-storage.js';
import { STORAGE_CONFIG } from './storage/storage.config.js';
import type { StorageConfig } from './storage/storage.config.js';

const ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';
/** A JPEG's first bytes (SOI marker + the next marker's FF). */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** An error's name and message for logs; storage SDK errors never carry credentials in these. */
const errorName = (error: unknown) => {
  const e = error as { name?: string; message?: string };
  return [e?.name, e?.message].filter(Boolean).join(': ').slice(0, 300) || 'unknown error';
};
/** Days in a trip (inclusive). */
export const tripDayCount = (trip: Pick<Trip, 'startDate' | 'endDate'>) => daysBetween(trip.startDate, trip.endDate) + 1;
/** The trip day of a local date, or null outside the trip. */
export function dayOfTrip(trip: Pick<Trip, 'startDate' | 'endDate'>, date: string): number | null {
  if (date < trip.startDate || date > trip.endDate) return null;
  return daysBetween(trip.startDate, date) + 1;
}
const dayLocked = () => conflict('MOMENT_DAY_LOCKED', "A photo taken with the camera keeps the day it was taken");
const zoneOr = (zone: string) => (isValidTimeZone(zone) ? zone : DEFAULT_TIMEZONE);

const momentNotFound = () => new AppError('NOT_FOUND', 'Moment not found');
const invalid = (fields: Record<string, string>) => new AppError('VALIDATION', 'Some fields are invalid', fields);
/** Some time in the future is allowed for clock skew. */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * Moments (docs/app-moments-spec.md §2): photos uploaded straight to object storage with signed
 * URLs, then verified. A trip's ready moments are visible to its members; unassigned ones only to
 * their author. The per-trip limit follows the trip OWNER's plan.
 */
@Injectable()
export class MomentsService {
  private readonly logger = new Logger(MomentsService.name);
  private readonly uploads = new RateWindow(UPLOAD_RATE_LIMIT.max, UPLOAD_RATE_LIMIT.windowMs, 'Too many photo uploads. Please wait a little.');

  constructor(
    @InjectRepository(Moment) private readonly moments: Repository<Moment>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(STORAGE_CONFIG) private readonly config: StorageConfig,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    private readonly appTrips: AppTripsService,
    private readonly billing: BillingService,
    @Optional() private readonly activity?: TripActivity,
  ) {}

  /** The photo limit of a trip: its owner's plan. */
  async tripLimit(trip: Pick<Trip, 'ownerUserId'>, manager?: EntityManager): Promise<number> {
    const plus = trip.ownerUserId ? await this.billing.isPlus(trip.ownerUserId, new Date(), manager) : false;
    return plus ? this.config.plusMomentsPerTrip : this.config.freeMomentsPerTrip;
  }

  /** A pending moment and where to PUT the photo. `tripId`: a trip the caller is a member of (any role). */
  async create(user: AuthUser, data: CreateMomentDto, timeZone: string, context: StorageRequestContext): Promise<CreatedMomentDto> {
    const takenAt = new Date(data.takenAt);
    if (takenAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) throw invalid({ takenAt: 'takenAt is in the future' });
    if ((data.lat == null) !== (data.lng == null)) throw invalid({ [data.lat == null ? 'lat' : 'lng']: 'lat and lng go together' });
    const source = data.source ?? 'camera';
    // Camera days come from takenAt at complete: a client-sent day (even null) is refused.
    if (source === 'camera' && data.day !== undefined) throw invalid({ day: 'day is only sent for uploads; a camera photo gets the day it was taken' });
    const trip = data.tripId ? (await this.appTrips.requireMembership(user, data.tripId)).trip! : null;
    const day = source === 'upload' ? (data.day ?? null) : null;
    if (day !== null) {
      if (!trip) throw invalid({ day: 'A photo without a trip has no day' });
      if (day > tripDayCount(trip)) throw invalid({ day: `day must be between 1 and ${tripDayCount(trip)}` });
    }
    this.uploads.take(user.id);

    const id = randomUUID();
    const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
    await this.moments.manager.transaction(async (manager) => {
      await this.checkRoom(manager, user.id, trip);
      await manager.insert(Moment, {
        id,
        userId: user.id,
        tripId: trip?.id ?? null,
        status: 'pending',
        source,
        day,
        objectKey: momentObjectKey(user.id, id),
        contentType: data.contentType,
        byteSize: data.byteSize,
        width: data.width,
        height: data.height,
        takenAt,
        takenOn: localIsoDate(zone, takenAt),
        lat: data.lat ?? null,
        lng: data.lng ?? null,
        completedAt: null,
      });
    });
    const moment = (await this.moments.findOne({ where: { id } }))!;
    const upload = await this.storage.presignUpload(moment.objectKey, { contentType: moment.contentType, byteSize: moment.byteSize }, context);
    this.logger.log(`Moment ${id} created by user ${user.id}${trip ? ` for trip ${trip.id}` : ' (unassigned)'}`);
    return { moment: (await this.present([moment], user, context))[0], upload };
  }

  /**
   * The uploader confirms the upload: the object must exist with the declared size and type. A
   * missing object → 409 UPLOAD_INCOMPLETE (PUT again, then retry). A wrong size or type → 409
   * UPLOAD_MISMATCH, and the moment and object are deleted. Idempotent once ready.
   */
  async complete(user: AuthUser, momentId: string, context: StorageRequestContext, timeZone: string = DEFAULT_TIMEZONE): Promise<MomentDto> {
    const moment = await this.requireOwn(user, momentId);
    if (moment.status === 'ready') return (await this.present([moment], user, context))[0];
    const object = await this.storage.stat(moment.objectKey);
    if (!object) throw conflict('UPLOAD_INCOMPLETE', 'The photo has not been uploaded yet');
    const type = object.contentType?.split(';')[0].trim().toLowerCase() || null;
    let accepted = object.size === moment.byteSize && type === moment.contentType;
    if (!accepted && object.size === moment.byteSize && type === null && moment.contentType === 'image/jpeg') {
      // Old app builds PUT without a Content-Type (before it was a signed header): accept a real
      // JPEG of the declared size and fix the stored type.
      accepted = await this.repairJpegType(moment);
    }
    if (!accepted) {
      await this.remove(moment);
      this.logger.warn(`Moment ${moment.id}: upload refused (size or type differs from the declared one)`);
      throw conflict('UPLOAD_MISMATCH', 'The uploaded photo does not match the declared size or type; start again');
    }
    // A member who left the trip since keeps the photo, unassigned.
    let tripId = moment.tripId;
    if (tripId && !(await this.members.findOne({ where: { tripId, userId: user.id } }))) tripId = null;
    const placed = await this.placement(moment, tripId, timeZone);
    await this.moments.update({ id: moment.id, status: 'pending' }, { status: 'ready', completedAt: new Date(), tripId, ...placed });
    const ready = (await this.moments.findOne({ where: { id: moment.id } }))!;
    await this.activity?.emit({ type: 'moment.completed', tripId: ready.tripId, userId: user.id });
    return (await this.present([ready], user, context))[0];
  }

  /** A trip's ready moments, newest first (members). */
  async listTrip(user: AuthUser, tripId: string, context: StorageRequestContext): Promise<MomentDto[]> {
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    const rows = await this.moments.find({ where: { tripId: trip!.id, status: 'ready' }, order: { takenAt: 'DESC', createdAt: 'DESC' } });
    return this.present(rows, user, context);
  }

  /** The caller's ready unassigned moments, newest first. */
  async listUnassigned(user: AuthUser, context: StorageRequestContext): Promise<MomentDto[]> {
    const rows = await this.moments.find({ where: { userId: user.id, tripId: IsNull(), status: 'ready' }, order: { takenAt: 'DESC', createdAt: 'DESC' } });
    return this.present(rows, user, context);
  }

  /**
   * `PATCH /moments/:id`. `tripId` (uploader only) moves it to a trip they're a member of (its
   * limit applies) or unassigns it: an upload's day resets to null, a camera day is recalculated.
   * `day` (uploads only: camera → 409 MOMENT_DAY_LOCKED) is for the uploader or the trip owner.
   */
  async patch(
    user: AuthUser,
    momentId: string,
    changes: { tripId?: string | null; day?: number | null },
    context: StorageRequestContext,
    timeZone: string = DEFAULT_TIMEZONE,
  ): Promise<MomentDto> {
    const moment = await this.requireVisible(user, momentId);
    if (changes.tripId === undefined && changes.day === undefined) throw invalid({ tripId: 'Send tripId or day' });
    if (changes.tripId !== undefined) {
      if (moment.userId !== user.id) throw new AppError('FORBIDDEN', 'Only the person who took this photo can move it');
      const trip = changes.tripId ? (await this.appTrips.requireMembership(user, changes.tripId)).trip! : null;
      if ((trip?.id ?? null) !== moment.tripId) {
        const placed = moment.source === 'camera' && moment.status === 'ready' ? await this.placement(moment, trip?.id ?? null, timeZone) : { day: null };
        await this.moments.manager.transaction(async (manager) => {
          await this.checkRoom(manager, user.id, trip);
          await manager.update(Moment, { id: moment.id }, { tripId: trip?.id ?? null, ...placed });
        });
        Object.assign(moment, { tripId: trip?.id ?? null, ...placed });
        if (moment.status === 'ready') await this.activity?.emit({ type: 'moment.completed', tripId: trip?.id ?? null, userId: user.id });
      }
    }
    if (changes.day !== undefined) {
      if (moment.userId !== user.id && !(await this.isTripOwner(user.id, moment.tripId))) {
        throw new AppError('FORBIDDEN', "Only the person who added this photo or the trip's owner can change its day");
      }
      if (moment.source === 'camera') throw dayLocked();
      if (changes.day !== null) {
        const trip = moment.tripId ? await this.trips.findOne({ where: { id: moment.tripId } }) : null;
        if (!trip) throw invalid({ day: 'A photo without a trip has no day' });
        if (changes.day > tripDayCount(trip)) throw invalid({ day: `day must be between 1 and ${tripDayCount(trip)}` });
      }
      if (changes.day !== moment.day) {
        await this.moments.update({ id: moment.id }, { day: changes.day });
        if (moment.status === 'ready' && moment.tripId) await this.activity?.emit({ type: 'moment.completed', tripId: moment.tripId, userId: moment.userId });
      }
    }
    const updated = (await this.moments.findOne({ where: { id: moment.id } }))!;
    return (await this.present([updated], user, context))[0];
  }

  /**
   * After a trip's dates change (in the trip update's transaction): upload days past the new length
   * become null; camera days are recalculated from the local date they were taken on.
   */
  async onDatesChanged(manager: EntityManager, trip: Trip): Promise<void> {
    const days = tripDayCount(trip);
    for (const moment of await manager.find(Moment, { where: { tripId: trip.id } })) {
      const day = moment.source === 'camera' ? (moment.status === 'ready' ? dayOfTrip(trip, moment.takenOn) : null) : moment.day != null && moment.day > days ? null : moment.day;
      if (day !== (moment.day ?? null)) await manager.update(Moment, { id: moment.id }, { day });
    }
  }

  /** The uploader, or the owner of the moment's trip. Other members → FORBIDDEN; anyone else → NOT_FOUND. */
  async delete(user: AuthUser, momentId: string): Promise<void> {
    const moment = await this.requireVisible(user, momentId);
    if (moment.userId !== user.id) {
      const membership = moment.tripId ? await this.members.findOne({ where: { tripId: moment.tripId, userId: user.id } }) : null;
      if (membership?.role !== 'owner') throw new AppError('FORBIDDEN', "Only the person who took this photo or the trip's owner can delete it");
    }
    await this.remove(moment);
  }

  /** Account deletion: every moment the user took, with its object. */
  async handleUserDeleted(userId: string): Promise<void> {
    for (;;) {
      const batch = await this.moments.find({ where: { userId }, take: PENDING_CLEANUP_BATCH });
      if (batch.length === 0) return;
      for (const moment of batch) await this.remove(moment);
    }
  }

  /** Pending moments never completed within the hour are removed, with any object (every 10 min). */
  @Interval('moments-pending-cleanup', PENDING_CLEANUP_INTERVAL_MS)
  async cleanupPending(now = new Date()): Promise<number> {
    let removed = 0;
    try {
      const cutoff = new Date(now.getTime() - PENDING_MOMENT_TTL_MS);
      for (;;) {
        const stale = await this.moments.find({ where: { status: 'pending', createdAt: LessThan(cutoff) }, take: PENDING_CLEANUP_BATCH });
        if (stale.length === 0) break;
        for (const moment of stale) await this.remove(moment);
        removed += stale.length;
      }
      if (removed > 0) this.logger.log(`Removed ${removed} pending moment(s) never completed`);
    } catch (error) {
      this.logger.error(`Pending moments cleanup failed: ${(error as Error).message}`);
    }
    return removed;
  }

  /** Signed thumbnails for the Journey: the trip's ready moments by `day` (both sources), newest first, up to `per` a day. */
  async thumbsByDay(tripId: string, per: number, context: StorageRequestContext): Promise<Map<number, string[]>> {
    const rows = await this.moments.find({ where: { tripId, status: 'ready' }, order: { takenAt: 'DESC', createdAt: 'DESC' } });
    const byDay = new Map<number, string[]>();
    for (const row of rows) {
      if (row.day == null) continue;
      const list = byDay.get(row.day) ?? [];
      if (list.length >= per) continue;
      list.push(await this.storage.presignDownload(row.objectKey, context));
      byDay.set(row.day, list);
    }
    return byDay;
  }

  /** A camera moment's day on `tripId` from takenAt in `timeZone` (the uploader's); an upload keeps its day. */
  private async placement(moment: Moment, tripId: string | null, timeZone: string): Promise<{ day: number | null; takenOn?: string }> {
    if (moment.source !== 'camera') return { day: tripId === moment.tripId ? (moment.day ?? null) : null };
    const takenOn = localIsoDate(zoneOr(timeZone), new Date(moment.takenAt));
    const trip = tripId ? await this.trips.findOne({ where: { id: tripId } }) : null;
    return { day: trip ? dayOfTrip(trip, takenOn) : null, takenOn };
  }

  private async isTripOwner(userId: string, tripId: string | null): Promise<boolean> {
    if (!tripId) return false;
    return (await this.members.findOne({ where: { tripId, userId } }))?.role === 'owner';
  }

  /** Room for one more moment on `trip` (its owner's plan) or among the user's unassigned ones, under a lock. */
  private async checkRoom(manager: EntityManager, userId: string, trip: Trip | null): Promise<void> {
    if (trip) {
      await manager.query(ADVISORY_XACT_LOCK, [`moments:trip:${trip.id}`]);
      const limit = await this.tripLimit(trip, manager);
      if ((await manager.count(Moment, { where: { tripId: trip.id } })) >= limit) {
        throw paymentRequired('MOMENTS_PLUS_REQUIRED', `The trip owner's plan allows ${limit} photos per trip`, { limit });
      }
    } else {
      await manager.query(ADVISORY_XACT_LOCK, [`moments:user:${userId}`]);
      if ((await manager.count(Moment, { where: { userId, tripId: IsNull() } })) >= MAX_UNASSIGNED_MOMENTS) {
        throw conflict('UNASSIGNED_MOMENTS_LIMIT', `At most ${MAX_UNASSIGNED_MOMENTS} photos can be without a trip; add some to a trip first`);
      }
    }
  }

  /** True if the object starts like a JPEG (FF D8 FF); its stored type is then set to image/jpeg. */
  private async repairJpegType(moment: Moment): Promise<boolean> {
    try {
      const start = await this.storage.readStart(moment.objectKey, JPEG_MAGIC.length);
      if (!start || !start.equals(JPEG_MAGIC)) return false;
      await this.storage.setContentType(moment.objectKey, 'image/jpeg');
      this.logger.log(`Moment ${moment.id}: uploaded without a Content-Type; JPEG confirmed and type fixed`);
      return true;
    } catch (error) {
      this.logger.warn(`Moment ${moment.id}: checking an untyped upload failed (key ${moment.objectKey}): ${errorName(error)}`);
      return false;
    }
  }

  /** Row first, then the object, awaited (a failure there is logged with the key: the row is what makes it visible). */
  private async remove(moment: Moment): Promise<void> {
    await this.moments.delete({ id: moment.id });
    try {
      await this.storage.delete(moment.objectKey);
    } catch (error) {
      this.logger.warn(`Moment ${moment.id}: deleting its object failed (key ${moment.objectKey}): ${errorName(error)}`);
    }
  }

  private async requireOwn(user: AuthUser, momentId: string): Promise<Moment> {
    if (!isUUID(momentId, '4')) throw momentNotFound();
    const moment = await this.moments.findOne({ where: { id: momentId.toLowerCase(), userId: user.id } });
    if (!moment) throw momentNotFound();
    return moment;
  }

  /** The caller's own moment, or a ready one on a trip they're a member of. */
  private async requireVisible(user: AuthUser, momentId: string): Promise<Moment> {
    if (!isUUID(momentId, '4')) throw momentNotFound();
    const moment = await this.moments.findOne({ where: { id: momentId.toLowerCase() } });
    if (!moment) throw momentNotFound();
    if (moment.userId === user.id) return moment;
    if (moment.status !== 'ready' || !moment.tripId) throw momentNotFound();
    if (!(await this.members.findOne({ where: { tripId: moment.tripId, userId: user.id } }))) throw momentNotFound();
    return moment;
  }

  private async present(rows: Moment[], viewer: AuthUser, context: StorageRequestContext): Promise<MomentDto[]> {
    const profiles = await this.users.getProfiles([...new Set(rows.map((m) => m.userId))]);
    const tripIds = [...new Set(rows.map((m) => m.tripId).filter((id): id is string => !!id))];
    const owned = new Set(
      tripIds.length ? (await this.members.find({ where: { tripId: In(tripIds), userId: viewer.id, role: 'owner' } })).map((m) => m.tripId) : [],
    );
    return Promise.all(
      rows.map(async (m) => {
        const profile = profiles.get(m.userId);
        const mine = m.userId === viewer.id;
        return {
          id: m.id,
          tripId: m.tripId ?? null,
          status: m.status,
          source: m.source ?? 'camera',
          day: m.day ?? null,
          dayEditable: m.source === 'upload' && (mine || (!!m.tripId && owned.has(m.tripId))),
          author: { userId: m.userId, displayName: profile?.displayName ?? 'Traveler', avatarUrl: profile?.avatarUrl ?? null },
          mine,
          contentType: m.contentType,
          byteSize: m.byteSize,
          width: m.width,
          height: m.height,
          takenAt: new Date(m.takenAt).toISOString(),
          takenOn: m.takenOn,
          // Privacy: coordinates only ever go back to the person who took the photo.
          location: mine && m.lat != null && m.lng != null ? { lat: Number(m.lat), lng: Number(m.lng) } : null,
          url: m.status === 'ready' ? await this.storage.presignDownload(m.objectKey, context) : null,
          createdAt: new Date(m.createdAt).toISOString(),
        };
      }),
    );
  }

  /** Counts for achievements: the user's ready moments (all trips and unassigned). */
  countReady(userId: string): Promise<number> {
    return this.moments.count({ where: { userId, status: 'ready' } });
  }

  /** The trip days that have a ready moment, either source (for `day_completed:<n>`). */
  async readyDays(tripId: string): Promise<Set<number>> {
    return new Set((await this.moments.find({ where: { tripId, status: 'ready' } })).map((m) => m.day).filter((d): d is number => d != null));
  }

  /** Ready moments on any of these trips (unused ids are fine). */
  readyOnTrips(tripIds: string[]): Promise<Moment[]> {
    return tripIds.length ? this.moments.find({ where: { tripId: In(tripIds), status: 'ready' } }) : Promise.resolve([]);
  }
}
