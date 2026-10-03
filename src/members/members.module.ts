import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { TripInvite } from './trip-invite.entity.js';
import { TripRemoval } from './trip-removal.entity.js';
import { MembersController } from './members.controller.js';
import { InvitesController } from './invites.controller.js';
import { MembersService } from './members.service.js';
import { InvitesService } from './invites.service.js';
import { INVITE_MAILER, MailInviteMailer } from './invite-mailer.js';
import { MailModule } from '../mail/mail.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripMember, TripInvite, TripRemoval]), AuthModule, AppTripsModule, MailModule],
  controllers: [MembersController, InvitesController],
  providers: [MembersService, InvitesService, { provide: INVITE_MAILER, useClass: MailInviteMailer }],
  exports: [MembersService],
})
export class MembersModule implements OnModuleInit {
  constructor(
    private readonly deletionHooks: UserDeletionHooks,
    private readonly members: MembersService,
  ) {}

  /** `DELETE /me` deletes or hands over the user's trips and drops their memberships and invites. */
  onModuleInit() {
    this.deletionHooks.register(async (userId) => {
      await this.members.handleUserDeleted(userId);
    });
  }
}
