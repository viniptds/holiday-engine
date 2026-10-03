import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import type { FindOptionsWhere } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { TripInvite } from './trip-invite.entity.js';
import { INVITE_MAILER } from './invite-mailer.js';
import type { InviteMailer } from './invite-mailer.js';
import { redactLinks, redactValues } from '../mail/redact.js';
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

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  /** Overall limit for sending one invite email in the background. */
  sendTimeoutMs = INVITE_SEND_TIMEOUT_MS;

  constructor(
    @InjectRepository(TripInvite) private readonly invites: Repository<TripInvite>,
    private readonly appTrips: AppTripsService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(INVITE_MAILER) private readonly mailer: InviteMailer,
    config: ConfigService,
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
    if (email !== null) await this.enforceEmailInviteLimits(user.id, tripId, email);

    const token = newToken();
    const invite = await this.invites.save(
      this.invites.create({
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
    const dto: InviteDto = {
      id: invite.id,
      url: `${this.baseUrl}/invite/${token}`,
      deepLink: `${INVITE_DEEP_LINK_BASE}${token}`,
      email: invite.email,
      role: invite.role,
      expiresAt: new Date(invite.expiresAt).toISOString(),
    };

    if (invite.email !== null) {
      const recipient = invite.email;
      this.inBackground(invite.id, [token, recipient], async () => {
        const name = (await this.users.getProfiles([user.id])).get(user.id)?.displayName?.trim();
        await this.mailer.sendInvite({
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
        });
      });
    }
    return dto;
  }

  /** Resolves once every background invite email has finished (used by tests and on shutdown). */
  async whenEmailsSettled(): Promise<void> {
    await Promise.allSettled([...this.pendingEmails]);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.whenEmailsSettled();
  }

  /**
   * Sliding windows over trip_invites.createdAt. Every email invite row counts (revoked or not
   * delivered too); a refused attempt creates none. Emails are stored lowercased, so recipients
   * match case-insensitively. Under heavy concurrency a burst can briefly exceed a limit.
   */
  private async enforceEmailInviteLimits(inviterId: string, tripId: string, email: string): Promise<void> {
    const now = Date.now();
    await this.enforceLimit(
      { tripId, email },
      EMAIL_INVITE_LIMITS.perRecipient,
      now,
      'This address was invited to this trip a few minutes ago; try again later',
    );
    await this.enforceLimit(
      { createdBy: inviterId, email: Not(IsNull()) },
      EMAIL_INVITE_LIMITS.perInviter,
      now,
      'Too many email invites in the last 24 hours; try again later',
    );
  }

  private async enforceLimit(
    where: FindOptionsWhere<TripInvite>,
    { max, windowMs }: { max: number; windowMs: number },
    now: number,
    message: string,
  ): Promise<void> {
    const rows = await this.invites.find({
      where: { ...where, createdAt: MoreThan(new Date(now - windowMs)) },
      order: { createdAt: 'ASC' },
      select: { id: true, createdAt: true },
    });
    if (rows.length < max) return;
    // A slot frees up when enough of the counted rows have left the window.
    const freedAt = new Date(rows[rows.length - max].createdAt).getTime() + windowMs;
    throw new AppError('RATE_LIMITED', message, undefined, { retryAfterSeconds: (freedAt - now) / 1000 });
  }

  /** Runs `work` without blocking the request, within `sendTimeoutMs`; failures are logged at warn, redacted. */
  private inBackground(inviteId: string, secrets: string[], work: () => Promise<void>): void {
    const job = withTimeout(work(), this.sendTimeoutMs)
      .catch((error: unknown) => {
        // Provider errors can echo the address or the link: keep both (and any link) out of the logs.
        const raw = error instanceof Error ? error.message : String(error);
        const detail = redactLinks(redactValues(raw, secrets.map((secret) => [secret, '[redacted]'] as [string, string])));
        this.logger.warn(`Sending invite ${inviteId} failed: ${detail}`);
      })
      .finally(() => this.pendingEmails.delete(job));
    this.pendingEmails.add(job);
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
   * email (FORBIDDEN otherwise, invite left unused) and is claimed with a conditional update
   * inside the transaction, so two concurrent accepts can't both use it.
   */
  async accept(user: AuthUser, token: string): Promise<AppTripDto> {
    const now = new Date();
    let tripId: string;
    try {
      tripId = await this.invites.manager.transaction(async (manager) => {
        const invite = await this.findUsable(token, manager.getRepository(TripInvite), now);
        const membership = { tripId: invite.tripId, userId: user.id };
        if (await manager.findOne(TripMember, { where: membership })) return invite.tripId;

        if (invite.email !== null) {
          // Email invites are only for the account with that email; a mismatch leaves the invite usable.
          if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
            throw new AppError('FORBIDDEN', 'This invite is for a different account');
          }
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
        return invite.tripId;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent accept by the same user added the membership first.
      tripId = (await this.findAny(token)).tripId;
    }
    return this.appTrips.get(user, tripId);
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
