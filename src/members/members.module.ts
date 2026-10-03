import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { TripInvite } from './trip-invite.entity.js';
import { MembersController } from './members.controller.js';
import { InvitesController } from './invites.controller.js';
import { MembersService } from './members.service.js';
import { InvitesService } from './invites.service.js';
import { INVITE_MAILER, LoggingInviteMailer } from './invite-mailer.js';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripMember, TripInvite]), AppTripsModule],
  controllers: [MembersController, InvitesController],
  providers: [MembersService, InvitesService, { provide: INVITE_MAILER, useClass: LoggingInviteMailer }],
  // MembersService.handleUserDeleted is wired to the users module's deletion hooks at G1.
  exports: [MembersService],
})
export class MembersModule {}
