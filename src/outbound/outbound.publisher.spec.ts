import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { OutboundPublisher } from './outbound.publisher.js';
import { BOT_MESSAGE_JOB, BOT_OUTBOUND_QUEUE } from './outbound.constants.js';

describe('OutboundPublisher', () => {
  const add = jest.fn(async () => ({ id: '1' }));
  let publisher: OutboundPublisher;

  beforeEach(async () => {
    add.mockClear();
    const moduleRef = await Test.createTestingModule({
      providers: [OutboundPublisher, { provide: getQueueToken(BOT_OUTBOUND_QUEUE), useValue: { add } }],
    }).compile();
    publisher = moduleRef.get(OutboundPublisher);
  });

  it('adds the contract envelope to the bot-outbound queue, echoing the correlation id', async () => {
    const target = { provider: 'telegram', chatId: '905820592', correlationId: 'c0ffee00-0000-4000-8000-000000000000' };

    await publisher.publish(target, 'trip.deleted', { tripId: 't1' });

    expect(add).toHaveBeenCalledWith(BOT_MESSAGE_JOB, {
      type: 'trip.deleted',
      provider: 'telegram',
      chatId: '905820592',
      correlationId: 'c0ffee00-0000-4000-8000-000000000000',
      payload: { tripId: 't1' },
    });
  });

  it('publishes engine-initiated messages with a null correlation id', async () => {
    await publisher.publish({ provider: 'telegram', chatId: '1', correlationId: null }, 'error', {
      code: 'INTERNAL',
      message: 'x',
      requestType: 'trip.list',
    });

    expect(add).toHaveBeenCalledWith(BOT_MESSAGE_JOB, expect.objectContaining({ correlationId: null }));
  });
});
