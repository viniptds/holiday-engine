import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TELEGRAM_JOB, TELEGRAM_QUEUE } from './messages.constants.js';
import type { InboundEnvelopeDto } from './dto/inbound-envelope.dto.js';

@Injectable()
export class MessagesService {
  constructor(@InjectQueue(TELEGRAM_QUEUE) private readonly queue: Queue) {}

  /** Queues the envelope and returns the job id (the 202 body promises one, so a missing id is an error). */
  async enqueue(message: InboundEnvelopeDto): Promise<string> {
    const { type, provider, chatId, correlationId, payload } = message;
    const job = await this.queue.add(TELEGRAM_JOB, { type, provider, chatId, correlationId, payload });
    if (!job.id) throw new Error('Queue returned a job without an id');
    return job.id;
  }
}
