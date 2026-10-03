import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Locale } from '../app-common/locale.js';
import { MAIL_TRANSPORT } from '../mail/mail.types.js';
import type { MailTransport } from '../mail/mail.types.js';
import { renderInviteEmail } from '../mail/templates/invite.js';
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
  sendInvite(invite: InviteEmail): Promise<void>;
}

export const INVITE_MAILER = Symbol('INVITE_MAILER');

/** Renders the invite in the inviter's locale and sends it through the configured `MailTransport`. */
@Injectable()
export class MailInviteMailer implements InviteMailer {
  private readonly logger = new Logger(MailInviteMailer.name);

  constructor(@Inject(MAIL_TRANSPORT) private readonly transport: MailTransport) {}

  async sendInvite(invite: InviteEmail): Promise<void> {
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
    const { id } = await this.transport.send({ to: invite.email, ...email, tags: ['trip-invite'] });
    this.logger.log(
      `Invite ${invite.inviteId} for trip ${invite.tripId} emailed (${invite.locale}, ${this.transport.provider}` +
        `${id ? `, message ${id}` : ''})`,
    );
  }
}
