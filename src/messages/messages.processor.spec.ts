import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MessagesProcessor } from './messages.processor.js';
import type { InboundMessage, MessagesRouter } from './messages.router.js';

describe('MessagesProcessor', () => {
  const route = jest.fn(async (_message: InboundMessage) => undefined);
  let processor: MessagesProcessor;

  beforeEach(() => {
    jest.restoreAllMocks();
    route.mockClear();
    processor = new MessagesProcessor({ route } as unknown as MessagesRouter);
  });

  it('logs the job id and type, and hands the message to the router', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const data = { type: 'trip.list', provider: 'telegram', chatId: '1', correlationId: 'c', payload: {} };

    await processor.process({ id: '1', data } as Job<InboundMessage>);

    expect(log).toHaveBeenCalledWith('Processing job 1 (trip.list)');
    expect(route).toHaveBeenCalledWith(data);
  });

  it('logs failed jobs', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    processor.onFailed({ id: '9' } as Job, new Error('boom'));

    expect(error).toHaveBeenCalledWith('Job 9 failed: boom');
  });
});
