import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { TripActivity } from '../app-trips/trip-activity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripScheduleHooks } from '../app-trips/trip-schedule-hooks.js';
import { ChecklistItem, ChecklistReminder } from '../checklist/checklist.entities.js';
import { MailModule } from '../mail/mail.module.js';
import { Trip } from '../trips/trip.entity.js';
import { MeExtensions } from '../users/me-extensions.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { User } from '../users/user.entity.js';
import { Notification, NotificationJob, PushTicket, PushToken } from './entities.js';
import { NOTIFICATIONS_CONFIG, NOTIFICATIONS_ENV_KEYS, readNotificationsConfig } from './notifications.config.js';
import type { NotificationsConfig } from './notifications.config.js';
import { EmailUnsubscribeController, MyNotificationsController } from './notifications.controller.js';
import { NotificationsScheduler } from './notifications.scheduler.js';
import { NotificationsService } from './notifications.service.js';
import { ExpoPushProvider } from './push/expo-push.js';
import { LogPushProvider } from './push/log-push.js';
import { PUSH_PROVIDER } from './push/push-provider.js';
import type { PushProvider } from './push/push-provider.js';

export function createPushProvider(config: NotificationsConfig): PushProvider {
  return config.pushProvider === 'expo' ? new ExpoPushProvider(config.expoAccessToken) : new LogPushProvider();
}

/** Notifications (docs/app-notifications-checklist-calendar-spec.md). Startup fails on bad settings. */
@Module({
  imports: [TypeOrmModule.forFeature([PushToken, Notification, NotificationJob, PushTicket, User, Trip, TripMember, ChecklistItem, ChecklistReminder]), AuthModule, AppTripsModule, MailModule],
  controllers: [MyNotificationsController, EmailUnsubscribeController],
  providers: [
    {
      provide: NOTIFICATIONS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => readNotificationsConfig(Object.fromEntries(NOTIFICATIONS_ENV_KEYS.map((k) => [k, config.get<string>(k)]))),
    },
    { provide: PUSH_PROVIDER, inject: [NOTIFICATIONS_CONFIG], useFactory: createPushProvider },
    NotificationsService,
    NotificationsScheduler,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly activity: TripActivity,
    private readonly scheduleHooks: TripScheduleHooks,
    private readonly deletionHooks: UserDeletionHooks,
    private readonly me: MeExtensions,
  ) {}

  onModuleInit() {
    new Logger(NotificationsModule.name).log('Notifications ready');
    this.activity.register((event) => this.notifications.onActivity(event));
    // New dates: the unsent countdowns go (in the update's transaction) and trip.saved plans them again.
    this.scheduleHooks.register((manager, trip) => this.notifications.onDatesChanged(manager, trip));
    this.deletionHooks.register((userId) => this.notifications.handleUserDeleted(userId));
    this.me.register(async ({ user, now }) => ({ unreadNotifications: await this.notifications.unreadCount(user.id, now) }));
  }
}
