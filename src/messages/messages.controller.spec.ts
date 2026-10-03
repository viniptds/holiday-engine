import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { envelopePipe, MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';
import { InboundEnvelopeDto } from './dto/inbound-envelope.dto.js';

const envelope = {
  type: 'trip.list' as const,
  provider: 'telegram',
  chatId: '905820592',
  correlationId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  payload: {},
};

describe('MessagesController', () => {
  it('enqueues the envelope and returns the job id', async () => {
    const enqueue = jest.fn(async () => '7');
    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [{ provide: MessagesService, useValue: { enqueue } }],
    }).compile();

    const result = await moduleRef.get(MessagesController).postMessage(envelope);

    expect(enqueue).toHaveBeenCalledWith(envelope);
    expect(result).toEqual({ jobId: '7' });
  });
});

describe('envelopePipe', () => {
  const transform = (body: unknown) => envelopePipe.transform(body, { type: 'body', metatype: InboundEnvelopeDto });

  it('accepts a contract envelope', async () => {
    await expect(transform(envelope)).resolves.toMatchObject(envelope);
  });

  it.each([
    ['type', { ...envelope, type: 'trip.explode' }],
    ['provider', { ...envelope, provider: 'whatsapp' }],
    ['chatId', { ...envelope, chatId: 905820592 }],
    ['correlationId', { ...envelope, correlationId: 'abc' }],
    ['payload', { ...envelope, payload: null }],
  ])('rejects an invalid %s with 400', async (_field, body) => {
    await expect(transform(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
