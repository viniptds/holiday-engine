import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import type { AuthUser, UserDirectory } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { TripInvite } from './trip-invite.entity.js';
import { INVITE_MAILER } from './invite-mailer.js';
import type { InviteMailer } from './invite-mailer.js';
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

const isUniqueViolation = (error: unknown) => (error as { code?: unknown })?.code === '23505';

/**
 * Trip invites. Only the token's SHA-256 is stored; the plain token appears once, in the
 * create response (and the email). Expired, revoked, used (email) and unknown invites all
 * behave as NOT_FOUND.
 */
@Injectable()
export class InvitesService {
  private readonly logger = new Logger(InvitesService.name);
  private readonly baseUrl: string;

  constructor(
    @InjectRepository(TripInvite) private readonly invites: Repository<TripInvite>,
    private readonly appTrips: AppTripsService,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(INVITE_MAILER) private readonly mailer: InviteMailer,
    config: ConfigService,
  ) {
    this.baseUrl = (config.get<string>('APP_INVITE_BASE_URL') || DEFAULT_INVITE_BASE_URL).replace(/\/+$/, '');
  }

  /** Owner or editor. Email invites are also sent through the `InviteMailer`. */
  async create(user: AuthUser, tripId: string, data: CreateInviteDto): Promise<InviteDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const token = newToken();
    const invite = await this.invites.save(
      this.invites.create({
        tripId,
        email: data.email ?? null,
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
      try {
        const invitedBy = (await this.users.getProfiles([user.id])).get(user.id)?.displayName ?? user.email;
        await this.mailer.sendInvite({
          inviteId: invite.id,
          tripId,
          email: invite.email,
          role: invite.role,
          destination: trip!.destination,
          invitedBy,
          url: dto.url,
          deepLink: dto.deepLink,
          expiresAt: new Date(invite.expiresAt),
        });
      } catch (error) {
        // The invite stands: the inviter still has the link to share.
        this.logger.error(`Sending invite ${invite.id} failed`, error instanceof Error ? error.stack : String(error));
      }
    }
    return dto;
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
   * inside the transaction, so two concurrent accepts can't both use it. The trip is returned
   * in `locale` (the request's language).
   */
  async accept(user: AuthUser, token: string, locale: Locale): Promise<AppTripDto> {
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
