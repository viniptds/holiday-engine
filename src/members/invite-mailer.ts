import { Injectable, Logger } from '@nestjs/common';
import type { InviteRole } from './members.types.js';

/** What an invite email needs. `url` and `deepLink` contain the plain token: never log them at info level. */
export type InviteEmail = {
  inviteId: string;
  tripId: string;
  email: string;
  role: InviteRole;
  destination: string;
  invitedBy: string;
  url: string;
  deepLink: string;
  expiresAt: Date;
};

/** Sends email invites. Injected with `INVITE_MAILER`. */
export interface InviteMailer {
  sendInvite(invite: InviteEmail): Promise<void>;
}

export const INVITE_MAILER = Symbol('INVITE_MAILER');

/** Default mailer: logs the invite instead of sending it. The link (with its token) is logged at debug only. */
@Injectable()
export class LoggingInviteMailer implements InviteMailer {
  private readonly logger = new Logger(LoggingInviteMailer.name);

  async sendInvite(invite: InviteEmail): Promise<void> {
    this.logger.log(
      `Invite ${invite.inviteId} to trip ${invite.tripId} (${invite.destination}) for ${invite.email} as ${invite.role}, ` +
        `from ${invite.invitedBy}, expires ${invite.expiresAt.toISOString()}`,
    );
    this.logger.debug(`Invite ${invite.inviteId} link: ${invite.url}`);
  }
}
