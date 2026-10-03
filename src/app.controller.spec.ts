import { Test } from '@nestjs/testing';
import { AppController } from './app.controller.js';

describe('AppController', () => {
  it('reports health', async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AppController] }).compile();

    expect(moduleRef.get(AppController).health()).toEqual({ status: 'ok' });
  });
});
