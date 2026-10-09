import { Module, OnModuleInit } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { MediaModule } from '../media/media.module.js';
import { MomentsModule } from '../moments/moments.module.js';
import { ChecklistItem } from '../checklist/checklist.entities.js';
import { Trip } from '../trips/trip.entity.js';
import { User } from '../users/user.entity.js';
import { UserAchievement } from './user-achievement.entity.js';
import { TripJourneySkip } from './trip-journey-skip.entity.js';
import { AchievementsService } from './achievements.service.js';
import { AchievementsController, JourneyController, MyAchievementsController } from './achievements.controller.js';

/** Achievements and the Journey path (docs/app-moments-spec.md §3). */
@Module({
  imports: [TypeOrmModule.forFeature([UserAchievement, TripJourneySkip, Trip, TripMember, TripPlace, User, ChecklistItem]), AuthModule, AppTripsModule, MomentsModule, MediaModule],
  controllers: [AchievementsController, MyAchievementsController, JourneyController],
  providers: [AchievementsService],
  exports: [AchievementsService],
})
export class AchievementsModule implements OnModuleInit {
  constructor(
    private readonly activity: TripActivity,
    private readonly achievements: AchievementsService,
  ) {}

  onModuleInit() {
    this.activity.register((event) => this.achievements.onActivity(event));
  }
}
