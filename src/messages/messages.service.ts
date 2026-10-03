import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { TELEGRAM_JOB, TELEGRAM_QUEUE } from './messages.constants.js';

@Injectable()
export class MessagesService {
  constructor(@InjectQueue(TELEGRAM_QUEUE) private readonly queue: Queue) {}

  async enqueue(payload: Record<string, unknown>): Promise<string | undefined> {
    const job = await this.queue.add(TELEGRAM_JOB, payload);
    return job.id;
  }
}
