import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventsModule } from './events.module.js';
import { EventsService } from './events.service.js';
import { EVENTS_PROVIDER } from './events.types.js';
import { MockEventsProvider } from './mock-events.provider.js';
import { SuggestedEvent } from './suggested-event.entity.js';

function compileWith(value: string | undefined) {
  return Test.createTestingModule({ imports: [EventsModule] })
    .overrideProvider(ConfigService)
    .useValue({ get: (key: string) => (key === 'EVENTS_PROVIDER' ? value : undefined) })
    .overrideProvider(getRepositoryToken(SuggestedEvent))
    .useValue({})
    .compile();
}

describe('EventsModule', () => {
  it.each([undefined, '', 'mock', ' Mock '])('uses the mock provider for EVENTS_PROVIDER=%p', async (value) => {
    const moduleRef = await compileWith(value);

    expect(moduleRef.get(EVENTS_PROVIDER)).toBeInstanceOf(MockEventsProvider);
    expect(moduleRef.get(EventsService)).toBeInstanceOf(EventsService);
  });

  it('fails at startup on an unknown provider', async () => {
    await expect(compileWith('ticketmaster')).rejects.toThrow(
      'Unknown EVENTS_PROVIDER "ticketmaster". Supported values: mock',
    );
  });
});
