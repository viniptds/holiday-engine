import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagesProcessor } from './messages.processor.js';
import { MessagesRouter } from './messages.router.js';
import { TELEGRAM_QUEUE } from './messages.constants.js';
import { TripsModule } from '../trips/trips.module.js';
import { EventsModule } from '../events/events.module.js';
import { OutboundModule } from '../outbound/outbound.module.js';

@Module({
  imports: [BullModule.registerQueue({ name: TELEGRAM_QUEUE }), TripsModule, EventsModule, OutboundModule],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesRouter, MessagesProcessor],
})
export class MessagesModule {}
