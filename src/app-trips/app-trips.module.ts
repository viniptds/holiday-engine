import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripsController } from './app-trips.controller.js';
import { AppTripsService } from './app-trips.service.js';
import { DevAuthGuard } from './dev-auth.guard.js';
import { StubUserDirectory } from './stub-user-directory.js';
import { WizardModule } from '../wizard/wizard.module.js';

@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripMember]), WizardModule],
  controllers: [AppTripsController],
  providers: [
    AppTripsService,
    DevAuthGuard,
    // TEMPORARY until the users module provides USER_DIRECTORY (gate G1).
    { provide: USER_DIRECTORY, useClass: StubUserDirectory },
  ],
})
export class AppTripsModule {}
