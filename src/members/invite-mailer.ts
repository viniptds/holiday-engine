import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Locale } from '../app-common/locale.js';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import type { MailTransport } from '../mail/mail.types.js';
import { renderInviteEmail } from '../mail/templates/invite.js';
import { abortable } from '../mail/abort.js';
import type { InviteRole } from './members.types.js';

/**
 * What an invite email needs. `url` and `deepLink` contain the live token: never log them, at any
 * level. Don't log `email` (the invitee's address) at info either: log the invite and trip ids.
 */
export type InviteEmail = {
  inviteId: string;
  tripId: string;
  email: string;
  role: InviteRole;
  destination: string;
  startDate: string;
  endDate: string;
  /** The inviter's display name, or null (the email then says "a Holid.ai traveler"). Never their email. */
  invitedBy: string | null;
  url: string;
  deepLink: string;
  expiresAt: Date;
  /** The inviter's language (`Accept-Language` of the create request). */
  locale: Locale;
};

/** Sends email invites. Injected with `INVITE_MAILER`. */
export interface InviteMailer {
  /** Rejects with `signal`'s reason as soon as it aborts; a late delivery is then never reported as a success. */
  sendInvite(invite: InviteEmail, signal?: AbortSignal): Promise<void>;
}

export const INVITE_MAILER = Symbol('INVITE_MAILER');

/** Renders the invite in the inviter's locale and sends it through the configured `MailTransport`. */
@Injectable()
export class MailInviteMailer implements InviteMailer {
  private readonly logger = new Logger(MailInviteMailer.name);

  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  async sendInvite(invite: InviteEmail, signal?: AbortSignal): Promise<void> {
    const email = renderInviteEmail(invite.locale, {
      inviter: invite.invitedBy,
      destination: invite.destination,
      startDate: invite.startDate,
      endDate: invite.endDate,
      role: invite.role,
      url: invite.url,
      deepLink: invite.deepLink,
      expiresAt: invite.expiresAt,
    });
    const sending = this.transport.send(
      { to: invite.email, ...email, tags: ['trip-invite'], idempotencyKey: `trip-invite/${invite.inviteId}` },
      signal,
    );
    // If the provider still answers after the abort (a driver that can't cancel), say so: the
    // caller has already logged this invite as failed.
    sending.then(
      ({ id }) => {
        if (signal?.aborted) this.logger.log(`Invite ${invite.inviteId} delivered after timeout${id ? ` (message ${id})` : ''}`);
      },
      () => undefined,
    );
    const { id } = await abortable(sending, signal);
    this.logger.log(
      `Invite ${invite.inviteId} for trip ${invite.tripId} emailed (${invite.locale}, ${this.transport.provider}` +
        `${id ? `, message ${id}` : ''})`,
    );
  }
}
