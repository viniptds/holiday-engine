import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { TELEGRAM_QUEUE } from './messages.constants.js';

@Processor(TELEGRAM_QUEUE)
export class MessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(MessagesProcessor.name);

  // Placeholder: jobs are only logged until the engine has real work to do.
  async process(job: Job): Promise<void> {
    this.logger.log(`Processing job ${job.id}: ${JSON.stringify(job.data)}`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }
}
