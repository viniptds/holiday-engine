import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { MessagesService } from './messages.service.js';
import { TELEGRAM_JOB, TELEGRAM_QUEUE } from './messages.constants.js';

describe('MessagesService', () => {
  it('adds the payload to the telegram queue and returns the job id', async () => {
    const add = jest.fn(async () => ({ id: '42' }));
    const moduleRef = await Test.createTestingModule({
      providers: [MessagesService, { provide: getQueueToken(TELEGRAM_QUEUE), useValue: { add } }],
    }).compile();

    const jobId = await moduleRef.get(MessagesService).enqueue({ chatId: 1, text: 'hi' });

    expect(add).toHaveBeenCalledWith(TELEGRAM_JOB, { chatId: 1, text: 'hi' });
    expect(jobId).toBe('42');
  });
});
