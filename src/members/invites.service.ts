import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { In, IsNull, MoreThan, Not, Repository } from 'typeorm';
import type { EntityManager, FindOptionsWhere } from 'typeorm';
import { AppError, forbidden } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { toMemberSummary } from '../app-trips/app-trip.mapper.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { TripInvite } from './trip-invite.entity.js';
import { TripRemoval } from './trip-removal.entity.js';
import { INVITE_MAILER } from './invite-mailer.js';
import type { InviteMailer } from './invite-mailer.js';
import { redactProviderError } from '../mail/redact.js';
import { abortable } from '../mail/abort.js';
import { DEFAULT_LOCALE } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { CreateInviteDto } from './dto/create-invite.dto.js';
import {
  DEFAULT_INVITE_BASE_URL,
  DEFAULT_INVITE_ROLE,
  INVITE_DEEP_LINK_BASE,
  INVITE_TTL_DAYS,
  InviteDto,
  InvitePreviewDto,
  InviteSummaryDto,
} from './members.types.js';

// 32 random bytes in base64url, as `newToken` makes them.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DAY_MS = 86_400_000;

const inviteNotFound = () => new AppError('NOT_FOUND', 'Invite not found');
const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** Usable: not revoked, not expired, and (for an email invite) not accepted yet. */
const isUsable = (invite: TripInvite, now: Date) =>
  invite.revokedAt === null &&
  new Date(invite.expiresAt).getTime() > now.getTime() &&
  (invite.email === null || invite.acceptedAt === null);

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const INVITE_SEND_TIMEOUT_MS = 15_000;

/** Email invites only; link invites aren't limited. */
export const EMAIL_INVITE_LIMITS = {
  perInviter: { max: 20, windowMs: 24 * 60 * 60 * 1000 },
  perRecipient: { max: 1, windowMs: 10 * 60 * 1000 },
};

/** Advisory lock statement (transaction-scoped): Postgres hashes the text key to a lock id. */
const ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

/**
 * Serializes email-invite creation for the rate limits. Always in this order (inviter, then trip +
 * recipient), so two transactions can't wait on each other: no deadlocks.
 */
async function lockEmailInviteKeys(manager: EntityManager, inviterId: string, tripId: string, email: string): Promise<void> {
  await manager.query(ADVISORY_XACT_LOCK, [`trip-invite:inviter:${inviterId}`]);
  await manager.query(ADVISORY_XACT_LOCK, [`trip-invite:recipient:${tripId}:${email}`]);
}

const isUniqueViolation = (error: unknown) => (error as { code?: unknown })?.code === '23505';

/**
 * Trip invites. Only the token's SHA-256 is stored; the plain token appears once, in the
 * create response (and the email). Expired, revoked, used (email) and unknown invites all
 * behave as NOT_FOUND.
 */
@Injectable()
export class InvitesService implements OnApplicationShutdown {
  private readonly logger = new Logger(InvitesService.name);
  private readonly baseUrl: string;
  private readonly pendingEmails = new Set<Promise<void>>();
  private readonly pendingAborts = new Set<AbortController>();
  /** Overall limit for sending one invite email in the background. */
  sendTimeoutMs = INVITE_SEND_TIMEOUT_MS;

  constructor(
    @InjectRepository(TripInvite) private readonly invites: Repository<TripInvite>,
    @InjectRepository(TripMember) private readonly memberships: Repository<TripMember>,
    private readonly appTrips: AppTripsService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(INVITE_MAILER) private readonly mailer: InviteMailer,
    config: ConfigService,
    @Optional() private readonly activity?: TripActivity,
  ) {
    this.baseUrl = (config.get<string>('APP_INVITE_BASE_URL') || DEFAULT_INVITE_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Owner or editor. Responds as soon as the invite exists: an email invite is then sent in the
   * background through the `InviteMailer`, in `locale` (the inviter's language), within
   * `sendTimeoutMs`. A failed send is logged at warn and the invite still stands.
   * Email invites are rate limited (RATE_LIMITED, nothing created); link invites aren't.
   */
  async create(user: AuthUser, tripId: string, data: CreateInviteDto, locale: Locale = DEFAULT_LOCALE): Promise<InviteDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const email = data.email ? normalizeEmail(data.email) : null;
    const token = newToken();
    // Check the limits and insert in one transaction, serialized per inviter and per (trip, recipient).
    const invite = await this.invites.manager.transaction(async (manager) => {
      if (email !== null) await lockEmailInviteKeys(manager, user.id, tripId, email);
      // Re-check the inviter's membership under a row lock: a concurrent removal or demotion (which
      // revokes their invites under the same lock) is then ordered before this insert, or after it
      // and revokes it too. Lock order: advisory keys, then this member row; nothing that holds a
      // member row lock takes an advisory lock, so there's no cycle.
      const inviter = await manager.findOne(TripMember, { where: { tripId, userId: user.id }, lock: { mode: 'pessimistic_write' } });
      if (!inviter) throw new AppError('NOT_FOUND', 'Trip not found');
      if (inviter.role === 'viewer') throw new AppError('FORBIDDEN', `A trip ${inviter.role} can't do this`);
      if (email !== null) await this.enforceEmailInviteLimits(manager.getRepository(TripInvite), user.id, tripId, email);
      return manager.save(
        manager.create(TripInvite, {
          tripId,
          email,
          tokenHash: hashToken(token),
          role: data.role ?? DEFAULT_INVITE_ROLE,
          createdBy: user.id,
          expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * DAY_MS),
          acceptedBy: null,
          acceptedAt: null,
          revokedAt: null,
        }),
      );
    });
    const dto: InviteDto = {
      id: invite.id,
      url: `${this.baseUrl}/invite/${token}`,
      deepLink: `${INVITE_DEEP_LINK_BASE}${token}`,
      email: invite.email,
      role: invite.role,
      expiresAt: new Date(invite.expiresAt).toISOString(),
    };

    await this.activity?.emit({ type: 'invite.created', tripId, userId: user.id, inviteId: invite.id, email: invite.email });
    if (invite.email !== null) {
      const recipient = invite.email;
      this.inBackground(invite.id, [token, recipient], async (signal) => {
        const name = (await this.users.getProfiles([user.id])).get(user.id)?.displayName?.trim();
        await this.mailer.sendInvite(
          {
          inviteId: invite.id,
          tripId,
          email: recipient,
          role: invite.role,
          destination: trip!.destination,
          startDate: trip!.startDate,
          endDate: trip!.endDate,
          // Never the inviter's email: without a display name the template says "a Holid.ai traveler".
          invitedBy: name || null,
          url: dto.url,
          deepLink: dto.deepLink,
          expiresAt: new Date(invite.expiresAt),
          locale,
          },
          signal,
        );
      });
    }
    return dto;
  }

  /** Resolves once every background invite email has finished (used by tests and on shutdown). */
  async whenEmailsSettled(): Promise<void> {
    await Promise.allSettled([...this.pendingEmails]);
  }

  /** On shutdown, aborts the sends still running (each is logged as failed) and waits for them to settle. */
  async onApplicationShutdown(): Promise<void> {
    for (const controller of this.pendingAborts) controller.abort(new Error('the engine is shutting down'));
    await this.whenEmailsSettled();
  }

  /**
   * Sliding windows over trip_invites.createdAt. Every email invite row counts (revoked or not
   * delivered too); a refused attempt creates none. Emails are stored lowercased, so recipients
   * match case-insensitively. Runs inside the create transaction, after `lockEmailInviteKeys`.
   */
  private async enforceEmailInviteLimits(
    invites: Pick<Repository<TripInvite>, 'find'>,
    inviterId: string,
    tripId: string,
    email: string,
  ): Promise<void> {
    const now = Date.now();
    await this.enforceLimit(
      invites,
      { tripId, email },
      EMAIL_INVITE_LIMITS.perRecipient,
      now,
      'This address was invited to this trip a few minutes ago; try again later',
    );
    await this.enforceLimit(
      invites,
      { createdBy: inviterId, email: Not(IsNull()) },
      EMAIL_INVITE_LIMITS.perInviter,
      now,
      'Too many email invites in the last 24 hours; try again later',
    );
  }

  private async enforceLimit(
    invites: Pick<Repository<TripInvite>, 'find'>,
    where: FindOptionsWhere<TripInvite>,
    { max, windowMs }: { max: number; windowMs: number },
    now: number,
    message: string,
  ): Promise<void> {
    const rows = await invites.find({
      where: { ...where, createdAt: MoreThan(new Date(now - windowMs)) },
      order: { createdAt: 'ASC' },
      select: { id: true, createdAt: true },
    });
    if (rows.length < max) return;
    // A slot frees up when enough of the counted rows have left the window.
    const freedAt = new Date(rows[rows.length - max].createdAt).getTime() + windowMs;
    throw new AppError('RATE_LIMITED', message, undefined, { retryAfterSeconds: (freedAt - now) / 1000 });
  }

  /**
   * Runs `work` without blocking the request. After `sendTimeoutMs` its signal aborts: the send is
   * cancelled where the provider allows it, and `work` rejects at once. Failures (timeouts too) are
   * logged at warn, with the token, the recipient, any email address and any link redacted.
   */
  private inBackground(inviteId: string, secrets: string[], work: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController();
    const ms = this.sendTimeoutMs;
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref();
    this.pendingAborts.add(controller);
    const job = abortable(work(controller.signal), controller.signal)
      .catch((error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Sending invite ${inviteId} failed: ${redactProviderError(raw, secrets)}`);
      })
      .finally(() => {
        clearTimeout(timer);
        this.pendingAborts.delete(controller);
        this.pendingEmails.delete(job);
      });
    this.pendingEmails.add(job);
  }

  /**
   * Pending invites (unused, unrevoked, unexpired), newest first. Owners see all of them,
   * editors only their own; viewers get FORBIDDEN.
   */
  async list(user: AuthUser, tripId: string): Promise<InviteSummaryDto[]> {
    const { role } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const invites = await this.invites.find({
      where: {
        tripId,
        revokedAt: IsNull(),
        acceptedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
        ...(role === 'owner' ? {} : { createdBy: user.id }),
      },
      order: { createdAt: 'DESC', id: 'ASC' },
    });

    const creatorIds = [...new Set(invites.map((i) => i.createdBy))];
    const [creators, profiles] = await Promise.all([
      creatorIds.length ? this.memberships.find({ where: { tripId, userId: In(creatorIds) } }) : Promise.resolve([]),
      this.users.getProfiles(creatorIds),
    ]);
    const roleOf = new Map(creators.map((m) => [m.userId, m.role]));

    return invites.map((invite) => ({
      id: invite.id,
      email: invite.email,
      role: invite.role,
      // A creator who left, was removed or demoted had their invites revoked, so they're a member;
      // `viewer` only keeps the shape valid if that ever isn't so.
      createdBy: toMemberSummary(
        { userId: invite.createdBy, role: roleOf.get(invite.createdBy) ?? 'viewer' } as TripMember,
        profiles.get(invite.createdBy),
      ),
      expiresAt: new Date(invite.expiresAt).toISOString(),
      createdAt: new Date(invite.createdAt).toISOString(),
    }));
  }

  /**
   * Revokes an active invite (unused, unrevoked, unexpired) of the trip: owners any, editors only
   * their own (FORBIDDEN otherwise). Anything else (used, revoked, expired, unknown, or another
   * trip's) is NOT_FOUND, like the listing, so revoking twice is a 404. The role check comes first.
   */
  async revoke(user: AuthUser, tripId: string, inviteId: string): Promise<void> {
    const { role } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    if (!isUUID(inviteId, '4')) throw inviteNotFound();
    const active = { id: inviteId.toLowerCase(), tripId, revokedAt: IsNull(), acceptedAt: IsNull() };
    const now = new Date();
    const invite = await this.invites.findOne({ where: { ...active, expiresAt: MoreThan(now) } });
    if (!invite) throw inviteNotFound();
    if (role !== 'owner' && invite.createdBy !== user.id) {
      throw new AppError('FORBIDDEN', 'Editors can only revoke their own invites');
    }
    // Conditional, so of two concurrent revokes (or a revoke racing an accept) only one wins.
    const { affected } = await this.invites.update({ ...active, expiresAt: MoreThan(now) }, { revokedAt: now });
    if (affected !== 1) throw inviteNotFound();
  }

  /** Any signed-in user holding a usable token. */
  async preview(token: string): Promise<InvitePreviewDto> {
    const invite = await this.findUsable(token);
    const trip = invite.trip!;
    const inviter = (await this.users.getProfiles([invite.createdBy])).get(invite.createdBy);
    return {
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
      invitedBy: inviter?.displayName ?? 'Traveler',
      role: invite.role,
      expiresAt: new Date(invite.expiresAt).toISOString(),
    };
  }

  /**
   * Joins the trip with the invite's role and returns it. An existing member gets the trip
   * unchanged (the invite isn't used up). An email invite only works for the account with that
   * email, and never for a dev-login account, whose email is unverified (FORBIDDEN otherwise,
   * invite left unused); it's claimed with a conditional update inside the transaction, so two
   * concurrent accepts can't both use it. The invite row is locked for the whole transaction, so a
   * concurrent revoke is ordered before or after the accept, never in between. Someone the owner removed can't rejoin through a link
   * invite (FORBIDDEN); accepting an email invite to them created after the removal lifts that.
   * The trip is returned in `locale` (the request's language).
   */
  async accept(user: AuthUser, token: string, locale: Locale): Promise<AppTripDto> {
    const now = new Date();
    let tripId: string;
    // The invite this call accepted (not an already-member no-op), for the inviter's notification.
    let accepted: TripInvite | null = null;
    try {
      tripId = await this.invites.manager.transaction(async (manager) => {
        const found = await this.findUsable(token, manager.getRepository(TripInvite), now);
        // Lock the invite and re-check it: a revoke (conditional on the same row) either committed
        // before this, and the invite is no longer usable, or waits until this accept is done. Accept
        // locks no member rows, so it can't form a lock cycle with remove/updateRole (member rows first,
        // then invites).
        const invite = await manager.findOne(TripInvite, { where: { id: found.id }, lock: { mode: 'pessimistic_write' } });
        if (!invite || !isUsable(invite, now)) throw inviteNotFound();
        const membership = { tripId: invite.tripId, userId: user.id };
        if (await manager.findOne(TripMember, { where: membership })) return invite.tripId;

        if (invite.email !== null) {
          // Email invites are only for the account with that email; a mismatch leaves the invite usable.
          if (user.devAccount) {
            throw forbidden('DEV_ACCOUNT_EMAIL_INVITE', "Test accounts can't accept email invites; use a link invite");
          }
          if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
            throw forbidden('INVITE_OTHER_ACCOUNT', 'This invite is for a different account');
          }
        }

        const removal = await manager.findOne(TripRemoval, { where: membership });
        const liftsRemoval = removal && invite.email !== null && new Date(invite.createdAt) > new Date(removal.removedAt);
        if (removal && !liftsRemoval) throw forbidden('REMOVED_FROM_TRIP', 'You were removed from this trip');

        if (invite.email !== null) {
          const { affected } = await manager.update(
            TripInvite,
            { id: invite.id, acceptedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(now) },
            { acceptedBy: user.id, acceptedAt: now },
          );
          if (affected !== 1) {
            // Another accept claimed it first; if that was this same user, they're in.
            if (await manager.findOne(TripMember, { where: membership })) return invite.tripId;
            throw inviteNotFound();
          }
        }
        await manager.insert(TripMember, { ...membership, role: invite.role });
        if (removal) await manager.delete(TripRemoval, membership);
        accepted = invite;
        return invite.tripId;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent accept by the same user added the membership first.
      tripId = (await this.findAny(token)).tripId;
    }
    await this.activity?.emit({ type: 'member.joined', tripId, userId: user.id });
    // Assigned inside the transaction callback (TypeScript can't see that).
    const acceptedInvite = accepted as TripInvite | null;
    if (acceptedInvite) {
      await this.activity?.emit({ type: 'invite.accepted', tripId, userId: user.id, inviterId: acceptedInvite.createdBy, emailInvite: acceptedInvite.email !== null });
    }
    return this.appTrips.get(user, tripId, locale);
  }

  private async findUsable(
    token: string,
    repository: Pick<Repository<TripInvite>, 'findOne'> = this.invites,
    now = new Date(),
  ): Promise<TripInvite> {
    if (!TOKEN.test(token)) throw inviteNotFound();
    const invite = await repository.findOne({ where: { tokenHash: hashToken(token) }, relations: { trip: true } });
    if (!invite || !isUsable(invite, now)) throw inviteNotFound();
    return invite;
  }

  private async findAny(token: string): Promise<TripInvite> {
    const invite = TOKEN.test(token) ? await this.invites.findOne({ where: { tokenHash: hashToken(token) } }) : null;
    if (!invite) throw inviteNotFound();
    return invite;
  }
}
