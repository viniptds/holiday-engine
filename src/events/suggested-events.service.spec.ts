import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { SuggestedEvent } from './suggested-event.entity.js';
import { SuggestedEventsService } from './suggested-events.service.js';

const TRIP_ID = '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';

describe('SuggestedEventsService', () => {
  const builder = {
    insert: jest.fn(() => builder),
    into: jest.fn(() => builder),
    values: jest.fn(() => builder),
    orIgnore: jest.fn(() => builder),
    returning: jest.fn(() => builder),
    execute: jest.fn(async () => ({ raw: [] as { externalId: string }[] })),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => builder),
    find: jest.fn(async (): Promise<{ externalId: string }[]> => []),
  };
  let service: SuggestedEventsService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [SuggestedEventsService, { provide: getRepositoryToken(SuggestedEvent), useValue: repo }],
    }).compile();
    service = moduleRef.get(SuggestedEventsService);
  });

  it('finds which of the ids were already sent for the trip', async () => {
    repo.find.mockResolvedValueOnce([{ externalId: 'b' }]);

    expect(await service.findSent(TRIP_ID, ['a', 'b'])).toEqual(new Set(['b']));
    expect(repo.find).toHaveBeenCalledWith({
      select: { externalId: true },
      where: { tripId: TRIP_ID, externalId: In(['a', 'b']) },
    });
  });

  it('inserts every id, ignoring ones already recorded, and returns the newly inserted ids', async () => {
    builder.execute.mockResolvedValueOnce({ raw: [{ externalId: 'b' }] });

    const fresh = await service.recordNew(TRIP_ID, ['a', 'b']);

    expect(builder.values).toHaveBeenCalledWith([
      { tripId: TRIP_ID, externalId: 'a' },
      { tripId: TRIP_ID, externalId: 'b' },
    ]);
    expect(builder.orIgnore).toHaveBeenCalled();
    expect(builder.returning).toHaveBeenCalledWith(['externalId']);
    expect(fresh).toEqual(new Set(['b']));
  });

  it('does not touch the database for an empty list', async () => {
    expect(await service.recordNew(TRIP_ID, [])).toEqual(new Set());
    expect(await service.findSent(TRIP_ID, [])).toEqual(new Set());
    expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    expect(repo.find).not.toHaveBeenCalled();
  });
});
