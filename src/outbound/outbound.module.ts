import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BOT_OUTBOUND_QUEUE } from './outbound.constants.js';
import { OutboundPublisher } from './outbound.publisher.js';

@Module({
  imports: [BullModule.registerQueue({ name: BOT_OUTBOUND_QUEUE })],
  providers: [OutboundPublisher],
  exports: [OutboundPublisher],
})
export class OutboundModule {}
