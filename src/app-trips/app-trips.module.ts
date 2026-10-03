import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { WizardModule } from '../wizard/wizard.module.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripsController } from './app-trips.controller.js';
import { AppTripsService } from './app-trips.service.js';

/** App trips. `AuthModule` provides `AuthGuard` and (through `UsersModule`) `USER_DIRECTORY`. */
@Module({
  imports: [TypeOrmModule.forFeature([Trip, TripMember]), AuthModule, WizardModule],
  controllers: [AppTripsController],
  providers: [AppTripsService],
  exports: [AppTripsService],
})
export class AppTripsModule {}
