import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, IsNull, LessThan, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { DEFAULT_LOCALE, matchLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { DEFAULT_TIMEZONE, isValidTimeZone, localIsoDate, zonedInstant } from '../app-common/timezone.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import type { TripActivityEvent } from '../app-trips/trip-activity.js';
import { ChecklistItem, ChecklistReminder } from '../checklist/checklist.entities.js';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import type { MailTransport } from '../mail/mail.types.js';
import { renderCountdownEmail } from '../mail/templates/countdown.js';
import { singleLine } from '../mail/templates/escape.js';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';
import { NOTIFICATION_COPY } from './copy.js';
import { Notification, NotificationJob, PushTicket, PushToken } from './entities.js';
import { NOTIFICATIONS_CONFIG } from './notifications.config.js';
import type { NotificationsConfig } from './notifications.config.js';
import { applyPrefsPatch, effectivePrefs, prefsPatchErrors } from './notification-prefs.js';
import type { NotificationPrefs, PushCategory } from './notification-prefs.js';
import { PUSH_PROVIDER } from './push/push-provider.js';
import type { PushProvider } from './push/push-provider.js';
import { UnsubscribeTokens } from './unsubscribe-token.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
export const INBOX_DAYS = 30;
export const INBOX_PAGE = 30;
/** Photos and places by others are combined into at most one notification per hour, per trip and recipient. */
export const COMBINE_WINDOW_MS = HOUR_MS;
export const COUNTDOWN_OFFSETS = [30, 7];
/** Trips starting within this many days get their countdown jobs planned. */
export const PLAN_AHEAD_DAYS = 45;
/** Several achievements unlocked at once (a lazy check) push once: at most one achievement push a minute per user. */
export const ACHIEVEMENT_PUSH_GAP_MS = 60_000;
/** A countdown missed by more than this (the trip was created inside the window, a long outage) isn't sent late. */
export const COUNTDOWN_GRACE_MS = 6 * HOUR_MS;
export const RECEIPT_DELAY_MS = 15 * 60_000;
export const RECEIPT_MAX_AGE_MS = DAY_MS;
const ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

export type NotificationDto = { id: string; type: string; tripId: string | null; title: string; body: string; data: Record<string, unknown>; createdAt: string; read: boolean };

type Rendered = { title: string; body: string };
type NotifyInput = {
  userId: string;
  type: string;
  /** The push toggle that gates it (the inbox row is written anyway). */
  category: PushCategory;
  tripId: string | null;
  /** Who caused it: never notified. */
  actorId?: string;
  /** Only current members of `tripId` get it (default true when there's a trip). */
  membersOnly?: boolean;
  data: Record<string, unknown>;
  render: (locale: Locale, user: User) => Rendered | Promise<Rendered>;
};

const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === '23505';
const localeOf = (user: User): Locale => matchLocale(user.locale) ?? DEFAULT_LOCALE;
const zoneOf = (user: User) => (isValidTimeZone(user.timezone) ? user.timezone : DEFAULT_TIMEZONE);
const name = (user: User | undefined, locale: Locale) => singleLine(user?.displayName ?? '') || NOTIFICATION_COPY[locale].someone;

/**
 * Notifications (docs/app-notifications-checklist-calendar-spec.md): the inbox, push through
 * PUSH_PROVIDER, combined trip activity, countdowns (push + email) and checklist reminders, sent
 * exactly once through `notification_jobs`.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly unsubscribe: UnsubscribeTokens;

  constructor(
    @InjectRepository(PushToken) private readonly tokens: Repository<PushToken>,
    @InjectRepository(Notification) private readonly inbox: Repository<Notification>,
    @InjectRepository(NotificationJob) private readonly jobs: Repository<NotificationJob>,
    @InjectRepository(PushTicket) private readonly tickets: Repository<PushTicket>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @InjectRepository(TripMember) private readonly members: Repository<TripMember>,
    @InjectRepository(ChecklistItem) private readonly items: Repository<ChecklistItem>,
    @InjectRepository(ChecklistReminder) private readonly reminders: Repository<ChecklistReminder>,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    @Inject(MAIL_TRANSPORT) private readonly mail: MailTransport,
    @Inject(NOTIFICATIONS_CONFIG) private readonly config: NotificationsConfig,
    settings: ConfigService,
  ) {
    const jwtSecret = settings.get<string>('JWT_SECRET');
    if (!jwtSecret) throw new Error('Notifications sign unsubscribe links with JWT_SECRET, which is missing');
    this.unsubscribe = new UnsubscribeTokens(jwtSecret);
  }

  // ---- Tokens, settings, inbox -------------------------------------------------------------

  /** Upsert: a token moves to whoever registers it last (a device that changed accounts). */
  async registerToken(user: AuthUser, token: string, platform: string, deviceId: string | null): Promise<void> {
    await this.tokens.save(this.tokens.create({ token, userId: user.id, platform, deviceId, lastSeenAt: new Date() }));
  }

  async removeToken(user: AuthUser, token: string): Promise<void> {
    await this.tokens.delete({ token, userId: user.id });
  }

  async settings(userId: string): Promise<NotificationPrefs> {
    const user = await this.users.findOne({ where: { id: userId } });
    return effectivePrefs(user?.notificationPrefs);
  }

  async updateSettings(user: AuthUser, patch: unknown): Promise<NotificationPrefs> {
    const errors = prefsPatchErrors(patch);
    if (Object.keys(errors).length) throw new AppError('VALIDATION', 'Some fields are invalid', errors);
    const next = applyPrefsPatch(await this.settings(user.id), patch as Parameters<typeof applyPrefsPatch>[1]);
    await this.users.update({ id: user.id }, { notificationPrefs: next });
    return next;
  }

  /** Newest first, the last 30 days, 30 a page; `before` is the previous page's `nextCursor`. */
  async list(user: AuthUser, before?: string, now = new Date()): Promise<{ notifications: NotificationDto[]; nextCursor: string | null }> {
    let cursor: Date | undefined;
    if (before !== undefined) {
      cursor = new Date(before);
      if (Number.isNaN(cursor.getTime())) throw new AppError('VALIDATION', 'Some fields are invalid', { before: 'before must be a cursor from a previous page' });
    }
    const since = now.getTime() - INBOX_DAYS * DAY_MS;
    const rows = (
      await this.inbox.find({
        where: { userId: user.id, ...(cursor ? { createdAt: LessThan(cursor) } : {}) },
        order: { createdAt: 'DESC' },
        take: INBOX_PAGE,
      })
    ).filter((n) => new Date(n.createdAt).getTime() >= since);
    const last = rows.at(-1);
    return { notifications: rows.map(toDto), nextCursor: rows.length === INBOX_PAGE && last ? new Date(last.createdAt).toISOString() : null };
  }

  async markRead(user: AuthUser, body: { ids?: string[]; all?: boolean }, now = new Date()): Promise<void> {
    if (body.all) await this.inbox.update({ userId: user.id, readAt: IsNull() }, { readAt: now });
    else if (body.ids?.length) await this.inbox.update({ userId: user.id, id: In(body.ids.map((id) => id.toLowerCase())), readAt: IsNull() }, { readAt: now });
  }

  async unreadCount(userId: string, now = new Date()): Promise<number> {
    return this.inbox.count({ where: { userId, readAt: IsNull(), createdAt: MoreThanOrEqual(new Date(now.getTime() - INBOX_DAYS * DAY_MS)) } });
  }

  /** `GET /email/unsubscribe?token=`: countdown emails off. False for a bad token. */
  async unsubscribeEmail(token: string): Promise<{ ok: boolean; locale: Locale | null }> {
    const userId = this.unsubscribe.verify(token);
    const user = userId ? await this.users.findOne({ where: { id: userId } }) : null;
    if (!user) return { ok: false, locale: null };
    const prefs = effectivePrefs(user.notificationPrefs);
    await this.users.update({ id: user.id }, { notificationPrefs: { ...prefs, email: { ...prefs.email, countdown: false } } });
    this.logger.log(`User ${user.id} turned countdown emails off (unsubscribe link)`);
    return { ok: true, locale: localeOf(user) };
  }

  unsubscribeUrl(userId: string): string {
    return `${this.config.publicUrl}/app/v1/email/unsubscribe?token=${this.unsubscribe.sign(userId)}`;
  }

  /** Account deletion: tokens, inbox and pending jobs go (the user row is only soft-deleted). */
  async handleUserDeleted(userId: string): Promise<void> {
    await this.tokens.delete({ userId });
    await this.inbox.delete({ userId });
    await this.jobs.delete({ userId, status: 'pending' });
  }

  // ---- notify -----------------------------------------------------------------------------

  /**
   * Writes the inbox row, then pushes when the category's toggle is on and the user has tokens.
   * Never the actor; never a deleted account; with a trip, only its current members. Returns
   * whether the user was notified. A push failure is logged and doesn't fail the call.
   */
  async notify(input: NotifyInput): Promise<boolean> {
    if (input.actorId && input.actorId === input.userId) return false;
    const user = await this.users.findOne({ where: { id: input.userId } });
    if (!user) return false;
    if (input.tripId && input.membersOnly !== false && !(await this.members.findOne({ where: { tripId: input.tripId, userId: user.id } }))) return false;
    const { title, body } = await input.render(localeOf(user), user);
    const data = { ...input.data, type: input.type };
    const row = await this.inbox.save(this.inbox.create({ userId: user.id, type: input.type, tripId: input.tripId, title, body, data, readAt: null }));
    if (effectivePrefs(user.notificationPrefs).push[input.category] && this.pushAllowed(user.id, input.type)) {
      await this.sendPush(user.id, { title, body, data: { ...data, notificationId: row.id } });
    }
    return true;
  }

  private readonly lastAchievementPush = new Map<string, number>();

  private pushAllowed(userId: string, type: string, now = Date.now()): boolean {
    if (type !== 'achievement') return true;
    if (now - (this.lastAchievementPush.get(userId) ?? 0) < ACHIEVEMENT_PUSH_GAP_MS) return false;
    this.lastAchievementPush.delete(userId);
    if (this.lastAchievementPush.size >= 10_000) this.lastAchievementPush.delete(this.lastAchievementPush.keys().next().value!);
    this.lastAchievementPush.set(userId, now);
    return true;
  }

  private async sendPush(userId: string, message: { title: string; body: string; data: Record<string, unknown> }): Promise<void> {
    const tokens = await this.tokens.find({ where: { userId } });
    if (tokens.length === 0) return;
    try {
      const results = await this.push.send(tokens.map((t) => ({ to: t.token, ...message })));
      for (const result of results) {
        if (result.ticketId) await this.tickets.insert({ id: result.ticketId, token: result.token }).catch(() => undefined);
        else if (result.error === 'DeviceNotRegistered') await this.tokens.delete({ token: result.token });
      }
    } catch (error) {
      this.logger.warn(`Push for user ${userId} failed (${this.push.name}): ${(error as Error).message}`);
    }
  }

  // ---- Events -----------------------------------------------------------------------------

  /** TripActivity listener. */
  async onActivity(event: TripActivityEvent, now = new Date()): Promise<void> {
    switch (event.type) {
      case 'trip.saved':
        await this.planCountdowns(now, event.tripId);
        return;
      case 'member.joined': {
        const trip = await this.trips.findOne({ where: { id: event.tripId } });
        const actor = await this.users.findOne({ where: { id: event.userId } });
        if (!trip) return;
        for (const member of await this.others(event.tripId, event.userId)) {
          await this.notify({
            userId: member.userId, type: 'trip.member_joined', category: 'tripActivity', tripId: trip.id, actorId: event.userId,
            data: { route: `/trip/${trip.id}`, tripId: trip.id },
            render: (l) => NOTIFICATION_COPY[l].memberJoined(name(actor ?? undefined, l), singleLine(trip.destination)),
          });
        }
        return;
      }
      case 'moment.completed':
        if (event.tripId && !event.quiet) for (const m of await this.others(event.tripId, event.userId)) await this.combine(m.userId, 'trip.photos', event.tripId, event.userId, now);
        return;
      case 'trip.itinerary':
        for (const m of await this.others(event.tripId, event.userId)) await this.combine(m.userId, 'trip.places', event.tripId, event.userId, now);
        return;
      case 'invite.created': {
        if (!event.email) return;
        const invitee = await this.users.findOne({ where: { email: event.email } });
        if (!invitee || invitee.id === event.userId || (await this.members.findOne({ where: { tripId: event.tripId, userId: invitee.id } }))) return;
        const [trip, inviter] = await Promise.all([this.trips.findOne({ where: { id: event.tripId } }), this.users.findOne({ where: { id: event.userId } })]);
        if (!trip) return;
        await this.notify({
          userId: invitee.id, type: 'invite.received', category: 'invites', tripId: trip.id, actorId: event.userId, membersOnly: false,
          // No invite link here: it carries a live token; the invite email has it.
          data: { route: '/notifications', tripId: trip.id, inviteId: event.inviteId },
          render: (l) => NOTIFICATION_COPY[l].inviteReceived(name(inviter ?? undefined, l), singleLine(trip.destination)),
        });
        return;
      }
      case 'invite.accepted': {
        if (!event.emailInvite) return;
        const [trip, acceptor] = await Promise.all([this.trips.findOne({ where: { id: event.tripId } }), this.users.findOne({ where: { id: event.userId } })]);
        if (!trip) return;
        await this.notify({
          userId: event.inviterId, type: 'invite.accepted', category: 'invites', tripId: trip.id, actorId: event.userId,
          data: { route: `/trip/${trip.id}`, tripId: trip.id },
          render: (l) => NOTIFICATION_COPY[l].inviteAccepted(name(acceptor ?? undefined, l), singleLine(trip.destination)),
        });
        return;
      }
      case 'achievement.unlocked': {
        const trip = event.tripId ? await this.trips.findOne({ where: { id: event.tripId } }) : null;
        await this.notify({
          userId: event.userId, type: 'achievement', category: 'achievements', tripId: trip?.id ?? null,
          data: { route: trip ? `/trip/${trip.id}/journey` : '/achievements', key: event.key, ...(trip ? { tripId: trip.id } : {}) },
          render: (l) => NOTIFICATION_COPY[l].achievement(trip ? singleLine(trip.destination) : null),
        });
        return;
      }
    }
  }

  /** Current members of the trip other than `userId`. */
  private async others(tripId: string, userId: string): Promise<TripMember[]> {
    return (await this.members.find({ where: { tripId } })).filter((m) => m.userId !== userId);
  }

  /**
   * Adds one photo or place change by `actorId` to the recipient's combined notification for the
   * trip: sent now if none went out in the last hour, otherwise folded into one pending job due
   * an hour after the last send.
   */
  async combine(recipientId: string, type: 'trip.photos' | 'trip.places', tripId: string, actorId: string, now = new Date()): Promise<void> {
    let sendNow: NotificationJob | null = null;
    await this.jobs.manager.transaction(async (manager) => {
      await manager.query(ADVISORY_XACT_LOCK, [`notify:combine:${recipientId}:${type}:${tripId}`]);
      const pending = await manager.findOne(NotificationJob, { where: { userId: recipientId, type, tripId, status: 'pending' } });
      if (pending) {
        const payload = (pending.payload ?? {}) as { count?: number; actorIds?: string[] };
        const actorIds = [...new Set([...(payload.actorIds ?? []), actorId])];
        await manager.update(NotificationJob, { id: pending.id }, { payload: { count: (payload.count ?? 0) + 1, actorIds } });
        return;
      }
      const last = (await manager.find(NotificationJob, { where: { userId: recipientId, type, tripId, status: 'sent' }, order: { sentAt: 'DESC' }, take: 1 }))[0];
      const lastSent = last?.sentAt ? new Date(last.sentAt).getTime() : 0;
      const dueAt = new Date(Math.max(now.getTime(), lastSent + COMBINE_WINDOW_MS));
      await manager.insert(NotificationJob, { userId: recipientId, type, tripId, itemId: '', dueAt, status: 'pending', payload: { count: 1, actorIds: [actorId] }, sentAt: null });
      if (dueAt.getTime() <= now.getTime()) sendNow = await manager.findOne(NotificationJob, { where: { userId: recipientId, type, tripId, status: 'pending' } });
    });
    if (sendNow) await this.sendJob(sendNow, now);
  }

  // ---- Scheduler work ---------------------------------------------------------------------

  /** One scheduler pass: plan countdowns and due reminders, send what's due, check receipts, prune the inbox. */
  async run(now = new Date()): Promise<{ sent: number }> {
    await this.planCountdowns(now);
    await this.planReminders(now);
    const sent = await this.sendDue(now);
    await this.checkReceipts(now);
    await this.inbox.delete({ createdAt: LessThan(new Date(now.getTime() - INBOX_DAYS * DAY_MS)) });
    return { sent };
  }

  /**
   * Countdown jobs (30 and 7 days before the start, at NOTIFICATIONS_SEND_HOUR in each member's
   * time zone) for app trips starting soon, or only `tripId`. Idempotent (unique key); one missed
   * by more than 6 h isn't planned.
   */
  async planCountdowns(now = new Date(), tripId?: string): Promise<void> {
    const from = new Date(now.getTime() - 2 * DAY_MS).toISOString().slice(0, 10);
    const until = new Date(now.getTime() + PLAN_AHEAD_DAYS * DAY_MS).toISOString().slice(0, 10);
    const trips = tripId
      ? await this.trips.find({ where: { id: tripId } })
      : (await this.trips.find({ where: { startDate: MoreThanOrEqual(from) } })).filter((t) => t.startDate <= until);
    for (const trip of trips.filter((t) => t.ownerUserId)) {
      const members = await this.members.find({ where: { tripId: trip.id } });
      const users = members.length ? await this.users.find({ where: { id: In(members.map((m) => m.userId)) } }) : [];
      for (const user of users) {
        for (const offset of COUNTDOWN_OFFSETS) {
          const date = new Date(Date.parse(`${trip.startDate}T00:00:00Z`) - offset * DAY_MS).toISOString().slice(0, 10);
          const dueAt = zonedInstant(zoneOf(user), date, this.config.sendHour);
          if (dueAt.getTime() < now.getTime() - COUNTDOWN_GRACE_MS) continue;
          await this.insertJob({ userId: user.id, type: 'countdown', tripId: trip.id, itemId: String(offset), dueAt });
        }
      }
    }
  }

  /** A trip's dates changed (in its update transaction): its unsent countdowns go, to be planned again. */
  async onDatesChanged(manager: EntityManager, trip: Trip): Promise<void> {
    await manager.delete(NotificationJob, { tripId: trip.id, type: 'countdown', status: 'pending' });
  }

  /** Reminders now due get a job (once per item, user and remindAt). */
  async planReminders(now = new Date()): Promise<void> {
    const due = await this.reminders.find({ where: { sentAt: IsNull(), remindAt: LessThanOrEqual(now) }, take: 500 });
    for (const reminder of due) {
      const item = await this.items.findOne({ where: { id: reminder.itemId } });
      if (!item) continue;
      await this.insertJob({ userId: reminder.userId, type: 'checklist.reminder', tripId: item.tripId, itemId: item.id, dueAt: new Date(reminder.remindAt) });
    }
  }

  async sendDue(now = new Date()): Promise<number> {
    let sent = 0;
    for (;;) {
      const due = await this.jobs.find({ where: { status: 'pending', dueAt: LessThanOrEqual(now) }, order: { dueAt: 'ASC' }, take: 200 });
      if (due.length === 0) return sent;
      for (const job of due) if (await this.sendJob(job, now)) sent++;
    }
  }

  /** Sends one job exactly once: it's claimed (pending → sending) first, so a second runner skips it. */
  async sendJob(job: NotificationJob, now = new Date()): Promise<boolean> {
    const { affected } = await this.jobs.update({ id: job.id, status: 'pending' }, { status: 'sending' });
    if (!affected) return false;
    try {
      const fresh = (await this.jobs.findOne({ where: { id: job.id } })) ?? job;
      const delivered = await this.deliver(fresh, now);
      await this.jobs.update({ id: job.id }, { status: delivered ? 'sent' : 'skipped', sentAt: now });
      return delivered;
    } catch (error) {
      await this.jobs.update({ id: job.id }, { status: 'failed', sentAt: now });
      this.logger.warn(`Notification job ${job.id} (${job.type}) failed: ${(error as Error).message}`);
      return false;
    }
  }

  private async deliver(job: NotificationJob, now: Date): Promise<boolean> {
    const trip = job.tripId ? await this.trips.findOne({ where: { id: job.tripId } }) : null;
    if (job.tripId && !trip) return false;
    switch (job.type) {
      case 'trip.photos':
      case 'trip.places': {
        const payload = (job.payload ?? {}) as { count?: number; actorIds?: string[] };
        const actors = payload.actorIds?.length ? await this.users.find({ where: { id: In(payload.actorIds) } }) : [];
        const byId = new Map(actors.map((a) => [a.id, a]));
        return this.notify({
          userId: job.userId, type: job.type, category: 'tripActivity', tripId: trip!.id,
          data: { route: job.type === 'trip.photos' ? `/trip/${trip!.id}/moments` : `/trip/${trip!.id}/itinerary`, tripId: trip!.id },
          render: (l) => {
            const names = NOTIFICATION_COPY[l].actors((payload.actorIds ?? []).map((id) => name(byId.get(id), l)));
            return job.type === 'trip.photos'
              ? NOTIFICATION_COPY[l].photos(names, payload.count ?? 1, singleLine(trip!.destination))
              : NOTIFICATION_COPY[l].places(names, singleLine(trip!.destination));
          },
        });
      }
      case 'countdown':
        return this.deliverCountdown(job, trip!);
      case 'checklist.reminder': {
        const reminder = await this.reminders.findOne({ where: { itemId: job.itemId, userId: job.userId } });
        const item = await this.items.findOne({ where: { id: job.itemId } });
        if (!reminder || !item || reminder.sentAt || new Date(reminder.remindAt).getTime() !== new Date(job.dueAt).getTime()) return false;
        await this.reminders.update({ itemId: reminder.itemId, userId: reminder.userId }, { sentAt: now });
        return this.notify({
          userId: job.userId, type: 'checklist.reminder', category: 'checklist', tripId: item.tripId,
          data: { route: `/trip/${item.tripId}/checklist`, tripId: item.tripId, itemId: item.id },
          render: (l) => NOTIFICATION_COPY[l].reminder(singleLine(item.title)),
        });
      }
      default:
        return false;
    }
  }

  /** The countdown push, plus the email (open checklist items by priority) when that member's email toggle is on. */
  private async deliverCountdown(job: NotificationJob, trip: Trip): Promise<boolean> {
    const days = Number(job.itemId);
    // The dates may have moved without a re-plan reaching this job yet.
    const expected = new Date(Date.parse(`${trip.startDate}T00:00:00Z`) - days * DAY_MS).toISOString().slice(0, 10);
    const user = await this.users.findOne({ where: { id: job.userId } });
    if (!user || localIsoDate(zoneOf(user), new Date(job.dueAt)) !== expected) return false;
    const destination = singleLine(trip.destination);
    const pushed = await this.notify({
      userId: user.id, type: 'countdown', category: 'countdown', tripId: trip.id,
      data: { route: `/trip/${trip.id}/checklist`, tripId: trip.id, daysLeft: days },
      render: (l) => NOTIFICATION_COPY[l].countdown(destination, days),
    });
    if (!pushed) return false;
    if (effectivePrefs(user.notificationPrefs).email.countdown && user.email) {
      const open = await this.items.find({ where: { tripId: trip.id, done: false }, order: { position: 'ASC' } });
      const email = renderCountdownEmail(localeOf(user), {
        destination: trip.destination,
        startDate: trip.startDate,
        endDate: trip.endDate,
        daysLeft: days,
        items: open.map((i) => ({ title: i.title, priority: i.priority })),
        appLink: `holidai://trip/${trip.id}/checklist`,
        unsubscribeUrl: this.unsubscribeUrl(user.id),
      });
      try {
        await this.mail.send({ to: user.email, ...email, tags: ['countdown'], idempotencyKey: `countdown/${job.id}` });
        this.logger.log(`Countdown email (${days} days) for trip ${trip.id} sent to user ${user.id} (${this.mail.provider})`);
      } catch (error) {
        this.logger.warn(`Countdown email for trip ${trip.id} to user ${user.id} failed: ${(error as Error).message}`);
      }
    }
    return true;
  }

  /** Receipts for tickets older than 15 minutes: DeviceNotRegistered deletes the token. Tickets go after a check or 24 h. */
  async checkReceipts(now = new Date()): Promise<void> {
    const ready = await this.tickets.find({ where: { createdAt: LessThanOrEqual(new Date(now.getTime() - RECEIPT_DELAY_MS)) }, take: 1000 });
    if (ready.length === 0) return;
    let receipts: Map<string, { status: string; error?: string }>;
    try {
      receipts = await this.push.receipts(ready.map((t) => t.id));
    } catch (error) {
      this.logger.warn(`Push receipts failed (${this.push.name}): ${(error as Error).message}`);
      return;
    }
    for (const ticket of ready) {
      const receipt = receipts.get(ticket.id);
      if (receipt?.error === 'DeviceNotRegistered') await this.tokens.delete({ token: ticket.token });
      if (receipt || new Date(ticket.createdAt).getTime() <= now.getTime() - RECEIPT_MAX_AGE_MS) await this.tickets.delete({ id: ticket.id });
    }
  }

  private async insertJob(job: Pick<NotificationJob, 'userId' | 'type' | 'tripId' | 'itemId' | 'dueAt'>): Promise<void> {
    if (await this.jobs.findOne({ where: { userId: job.userId, type: job.type, tripId: job.tripId ?? IsNull(), itemId: job.itemId, dueAt: job.dueAt } })) return;
    try {
      await this.jobs.insert({ ...job, status: 'pending', payload: null, sentAt: null });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}

function toDto(n: Notification): NotificationDto {
  return { id: n.id, type: n.type, tripId: n.tripId ?? null, title: n.title, body: n.body, data: n.data ?? {}, createdAt: new Date(n.createdAt).toISOString(), read: n.readAt != null };
}
