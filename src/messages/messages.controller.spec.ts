import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { MessagesController } from './messages.controller.js';
import { MessagesService } from './messages.service.js';

describe('MessagesController', () => {
  it('enqueues the request body and returns the job id', async () => {
    const enqueue = jest.fn(async () => '7');
    const moduleRef = await Test.createTestingModule({
      controllers: [MessagesController],
      providers: [{ provide: MessagesService, useValue: { enqueue } }],
    }).compile();

    const result = await moduleRef.get(MessagesController).postMessage({ text: 'hello' });

    expect(enqueue).toHaveBeenCalledWith({ text: 'hello' });
    expect(result).toEqual({ jobId: '7' });
  });
});
