import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service.js';

export const NOTIFICATIONS_INTERVAL_MS = 5 * 60_000;

/** Every 5 minutes: plan countdowns and reminders, send due jobs once, check push receipts. Safe across restarts (state is in the jobs table). */
@Injectable()
export class NotificationsScheduler {
  private readonly logger = new Logger(NotificationsScheduler.name);
  private running = false;

  constructor(private readonly notifications: NotificationsService) {}

  @Interval('notifications', NOTIFICATIONS_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { sent } = await this.notifications.run();
      if (sent > 0) this.logger.log(`Sent ${sent} scheduled notification(s)`);
    } catch (error) {
      this.logger.error(`Notifications run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
