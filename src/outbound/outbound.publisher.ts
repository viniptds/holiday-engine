import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { BOT_MESSAGE_JOB, BOT_OUTBOUND_QUEUE } from './outbound.constants.js';
import type { OutboundMessage, OutboundPayloads, OutboundType } from './outbound.types.js';

/** Who a message goes to; for replies, the inbound request being answered. */
export type OutboundTarget = { provider: string; chatId: string; correlationId: string | null };

/** Publishes messages for the bot on the `bot-outbound` queue. */
@Injectable()
export class OutboundPublisher {
  constructor(@InjectQueue(BOT_OUTBOUND_QUEUE) private readonly queue: Queue) {}

  async publish<T extends OutboundType>(
    target: OutboundTarget,
    type: T,
    payload: OutboundPayloads[T],
  ): Promise<OutboundMessage<T>> {
    const message = {
      type,
      provider: target.provider,
      chatId: target.chatId,
      correlationId: target.correlationId,
      payload,
    } as OutboundMessage<T>;
    await this.queue.add(BOT_MESSAGE_JOB, message);
    return message;
  }
}
