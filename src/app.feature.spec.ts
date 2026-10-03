import { jest } from '@jest/globals';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { AppController } from './app.controller.js';
import { MessagesModule } from './messages/messages.module.js';
import { MessagesProcessor } from './messages/messages.processor.js';
import { TELEGRAM_JOB, TELEGRAM_QUEUE } from './messages/messages.constants.js';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Trip } from './trips/trip.entity.js';
import { SuggestedEvent } from './events/suggested-event.entity.js';
import { BOT_OUTBOUND_QUEUE } from './outbound/outbound.constants.js';

/**
 * Feature tests: the real Nest HTTP stack (routing, body parsing, status codes) over a
 * real port, with only the Redis-backed queue and worker replaced.
 * Uses Node's global fetch, so no HTTP test client package is needed.
 */
describe('HTTP API (feature)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const add = jest.fn(async (_name: string, _data: unknown) => ({ id: '101' }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [BullModule.forRoot({ connection: { host: 'localhost', port: 6379 } }), MessagesModule],
      controllers: [AppController],
    })
      .overrideProvider(getQueueToken(TELEGRAM_QUEUE))
      .useValue({ add })
      // Only the HTTP side is exercised here; the router's dependencies just need to resolve.
      .overrideProvider(getQueueToken(BOT_OUTBOUND_QUEUE))
      .useValue({})
      .overrideProvider(getRepositoryToken(Trip))
      .useValue({})
      .overrideProvider(getRepositoryToken(SuggestedEvent))
      .useValue({})
      // The worker would open a Redis connection; its behaviour is covered by its own spec.
      .overrideProvider(MessagesProcessor)
      .useValue({})
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => add.mockClear());

  const post = (body: string, contentType = 'application/json') =>
    fetch(`${baseUrl}/post-message`, { method: 'POST', headers: { 'content-type': contentType }, body });

  const envelope = {
    type: 'trip.create',
    provider: 'telegram',
    chatId: '905820592',
    correlationId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
    payload: { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' },
  };

  describe('GET /', () => {
    it('returns 200 { status: "ok" }', async () => {
      const res = await fetch(`${baseUrl}/`);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/application\/json/);
      expect(await res.json()).toEqual({ status: 'ok' });
    });
  });

  describe('POST /post-message', () => {
    it('queues a contract envelope unchanged and returns 202 { jobId }', async () => {
      const res = await post(JSON.stringify(envelope));

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ jobId: '101' });
      expect(add).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledWith(TELEGRAM_JOB, envelope);
    });

    it.each(['trip.list', 'trip.update', 'trip.delete', 'events.suggest'])(
      'accepts the %s request type',
      async (type) => {
        const res = await post(JSON.stringify({ ...envelope, type, payload: {} }));

        expect(res.status).toBe(202);
      },
    );

    it('keeps chatId as a string larger than 2^31 without precision loss', async () => {
      const chatId = '-1009876543210123';

      await post(JSON.stringify({ ...envelope, chatId }));

      expect(add.mock.calls[0][1]).toMatchObject({ chatId });
    });

    it('rejects malformed JSON with 400 and does not queue', async () => {
      const res = await post('{"type": ');

      expect(res.status).toBe(400);
      expect(add).not.toHaveBeenCalled();
    });

    it('returns 500 when the queue is unavailable', async () => {
      add.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const res = await post(JSON.stringify(envelope));

      expect(res.status).toBe(500);
    });

    it('does not route GET', async () => {
      const res = await fetch(`${baseUrl}/post-message`);

      expect(res.status).toBe(404);
    });

    // BUG-001 (fixed): the contract requires a validated envelope (malformed → 400); any body used to be queued.
    // BUG-002 (fixed): `provider` must be "telegram".
    describe('envelope validation (contract: malformed envelope → 400)', () => {
      const { type: _type, ...withoutType } = envelope;
      const { chatId: _chatId, ...withoutChatId } = envelope;

      it.each([
        ['an empty object', {}],
        ['a missing type', withoutType],
        ['an unknown type', { ...envelope, type: 'trip.explode' }],
        ['a missing chatId', withoutChatId],
        ['a numeric chatId', { ...envelope, chatId: 905820592 }],
        ['a non-uuid correlationId', { ...envelope, correlationId: 'abc' }],
        ['an unknown provider', { ...envelope, provider: 'whatsapp' }],
        ['a non-object payload', { ...envelope, payload: 'x' }],
        ['a JSON array', [envelope]],
      ])('rejects %s with 400', async (_label, body) => {
        const res = await post(JSON.stringify(body));

        expect(res.status).toBe(400);
        expect(add).not.toHaveBeenCalled();
      });

      it('rejects a non-JSON content type with 400', async () => {
        const res = await post('hello', 'text/plain');

        expect(res.status).toBe(400);
        expect(add).not.toHaveBeenCalled();
      });
    });
  });
});
