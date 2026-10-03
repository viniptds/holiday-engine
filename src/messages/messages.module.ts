import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { MessagesProcessor } from './messages.processor.js';
import { TELEGRAM_QUEUE } from './messages.constants.js';

@Module({
  imports: [BullModule.registerQueue({ name: TELEGRAM_QUEUE })],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesProcessor],
})
export class MessagesModule {}
