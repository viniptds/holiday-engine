import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TELEGRAM_QUEUE } from './messages.constants.js';
import { MessagesRouter } from './messages.router.js';
import type { InboundMessage } from './messages.router.js';

@Processor(TELEGRAM_QUEUE)
export class MessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(MessagesProcessor.name);

  constructor(private readonly router: MessagesRouter) {
    super();
  }

  async process(job: Job<InboundMessage>): Promise<void> {
    this.logger.log(`Processing job ${job.id} (${job.data.type})`);
    await this.router.route(job.data);
  }

  // Only reached when the reply itself can't be published (e.g. Redis is down).
  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }
}
