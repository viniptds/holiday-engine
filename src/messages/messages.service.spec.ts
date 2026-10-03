import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { MessagesService } from './messages.service.js';
import { TELEGRAM_JOB, TELEGRAM_QUEUE } from './messages.constants.js';

const envelope = {
  type: 'trip.list' as const,
  provider: 'telegram',
  chatId: '905820592',
  correlationId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  payload: {},
};

describe('MessagesService', () => {
  const add = jest.fn(async (): Promise<{ id?: string }> => ({ id: '42' }));
  let service: MessagesService;

  beforeEach(async () => {
    add.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [MessagesService, { provide: getQueueToken(TELEGRAM_QUEUE), useValue: { add } }],
    }).compile();
    service = moduleRef.get(MessagesService);
  });

  it('adds the envelope to the telegram queue and returns the job id', async () => {
    const jobId = await service.enqueue(envelope);

    expect(add).toHaveBeenCalledWith(TELEGRAM_JOB, envelope);
    expect(jobId).toBe('42');
  });

  it('queues only the envelope fields', async () => {
    await service.enqueue({ ...envelope, extra: 'x' } as typeof envelope);

    expect(add).toHaveBeenCalledWith(TELEGRAM_JOB, envelope);
  });

  // BUG-011: the 202 body promises a jobId.
  it('throws when the queue returns no job id', async () => {
    add.mockResolvedValueOnce({});

    await expect(service.enqueue(envelope)).rejects.toThrow('Queue returned a job without an id');
  });
});
