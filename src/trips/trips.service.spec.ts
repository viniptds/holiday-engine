import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { Trip } from './trip.entity.js';
import { TripsService } from './trips.service.js';
import { TripNotFoundError, TripValidationError } from './trips.errors.js';
import { toTripDto } from './trip.dto.js';

const owner = { provider: 'telegram', chatId: '905820592' };
const TRIP_ID = '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return Object.assign(new Trip(), {
    id: TRIP_ID,
    provider: 'telegram',
    chatId: '905820592',
    destination: 'Lisbon',
    startDate: '2026-11-01',
    endDate: '2026-11-05',
    notes: null,
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
    updatedAt: new Date('2026-10-03T10:00:00.000Z'),
    ...overrides,
  });
}

describe('TripsService', () => {
  let service: TripsService;
  const repo = {
    create: jest.fn((data: Partial<Trip>) => Object.assign(new Trip(), data)),
    save: jest.fn(async (trip: Trip) => trip),
    find: jest.fn(async (): Promise<Trip[]> => []),
    findOneBy: jest.fn(async (): Promise<Trip | null> => null),
    remove: jest.fn(async (trip: Trip) => trip),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [TripsService, { provide: getRepositoryToken(Trip), useValue: repo }],
    }).compile();
    service = moduleRef.get(TripsService);
  });

  it('creates a trip owned by the chat, defaulting notes to null', async () => {
    const trip = await service.create(owner, {
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
    });

    expect(repo.create).toHaveBeenCalledWith({
      provider: 'telegram',
      chatId: '905820592',
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      notes: null,
    });
    expect(repo.save).toHaveBeenCalledWith(trip);
  });

  it('lists the chat trips sorted by startDate', async () => {
    const trips = [makeTrip()];
    repo.find.mockResolvedValueOnce(trips);

    await expect(service.listForChat(owner)).resolves.toBe(trips);
    expect(repo.find).toHaveBeenCalledWith({
      where: { provider: 'telegram', chatId: '905820592' },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  });

  it('gets a trip scoped by owner', async () => {
    const trip = makeTrip();
    repo.findOneBy.mockResolvedValueOnce(trip);

    await expect(service.getForChat(owner, TRIP_ID)).resolves.toBe(trip);
    expect(repo.findOneBy).toHaveBeenCalledWith({ id: TRIP_ID, provider: 'telegram', chatId: '905820592' });
  });

  it('throws TripNotFoundError for a trip of another chat (repository finds nothing)', async () => {
    await expect(service.getForChat({ provider: 'telegram', chatId: '1' }, TRIP_ID)).rejects.toBeInstanceOf(
      TripNotFoundError,
    );
  });

  it('throws TripNotFoundError for a non-uuid id without querying', async () => {
    await expect(service.getForChat(owner, 'nope')).rejects.toBeInstanceOf(TripNotFoundError);
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('updates only the provided fields', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip({ notes: 'old' }));

    const trip = await service.update(owner, { tripId: TRIP_ID, destination: 'Porto', notes: null });

    expect(trip).toMatchObject({ destination: 'Porto', startDate: '2026-11-01', endDate: '2026-11-05', notes: null });
    expect(repo.save).toHaveBeenCalledWith(trip);
  });

  it('rejects an update that puts endDate before the stored startDate', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    await expect(service.update(owner, { tripId: TRIP_ID, endDate: '2026-10-31' })).rejects.toBeInstanceOf(
      TripValidationError,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  // BUG-008: the 365-day cap also applies when only one date changes.
  it('rejects an update that makes the stored trip longer than 365 days', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    await expect(service.update(owner, { tripId: TRIP_ID, endDate: '2027-11-02' })).rejects.toThrow(
      'endDate must be at most 365 days after startDate',
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  // BUG-006: only v4 UUIDs reach the database.
  it('throws TripNotFoundError for the nil UUID without querying', async () => {
    await expect(service.getForChat(owner, '00000000-0000-0000-0000-000000000000')).rejects.toBeInstanceOf(
      TripNotFoundError,
    );
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('throws TripNotFoundError when updating a trip of another chat', async () => {
    await expect(service.update(owner, { tripId: TRIP_ID, destination: 'Porto' })).rejects.toBeInstanceOf(
      TripNotFoundError,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('deletes an owned trip', async () => {
    const trip = makeTrip();
    repo.findOneBy.mockResolvedValueOnce(trip);

    await service.delete(owner, TRIP_ID);

    expect(repo.remove).toHaveBeenCalledWith(trip);
  });

  it('throws TripNotFoundError when deleting a trip of another chat', async () => {
    await expect(service.delete(owner, TRIP_ID)).rejects.toBeInstanceOf(TripNotFoundError);
    expect(repo.remove).not.toHaveBeenCalled();
  });

  it('keeps notes when creating with notes', async () => {
    await service.create(owner, { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05', notes: 'beach' });

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ notes: 'beach' }));
  });

  it('ignores ownership fields smuggled into the create payload', async () => {
    const data = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05', chatId: '1', id: TRIP_ID };

    await service.create(owner, data);

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ chatId: '905820592' }));
    expect(repo.create).toHaveBeenCalledWith(expect.not.objectContaining({ id: expect.anything() }));
  });

  it('treats an uppercase uuid as valid', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    await service.getForChat(owner, TRIP_ID.toUpperCase());

    expect(repo.findOneBy).toHaveBeenCalled();
  });

  it('does not query for ids that only contain a uuid', async () => {
    await expect(service.getForChat(owner, `x${TRIP_ID}`)).rejects.toBeInstanceOf(TripNotFoundError);
    await expect(service.getForChat(owner, `${TRIP_ID}\n`)).rejects.toBeInstanceOf(TripNotFoundError);
    expect(repo.findOneBy).not.toHaveBeenCalled();
  });

  it('updates both dates at once', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    const trip = await service.update(owner, { tripId: TRIP_ID, startDate: '2026-12-01', endDate: '2026-12-03' });

    expect(trip).toMatchObject({ startDate: '2026-12-01', endDate: '2026-12-03' });
  });

  it('rejects an update that moves startDate after the stored endDate', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    await expect(service.update(owner, { tripId: TRIP_ID, startDate: '2026-11-06' })).rejects.toBeInstanceOf(
      TripValidationError,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('allows an update that makes the trip one day long', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip());

    await expect(service.update(owner, { tripId: TRIP_ID, startDate: '2026-11-05' })).resolves.toMatchObject({
      startDate: '2026-11-05',
      endDate: '2026-11-05',
    });
  });

  it('leaves notes unchanged when omitted', async () => {
    repo.findOneBy.mockResolvedValueOnce(makeTrip({ notes: 'keep me' }));

    await expect(service.update(owner, { tripId: TRIP_ID, destination: 'Porto' })).resolves.toMatchObject({
      notes: 'keep me',
    });
  });

  it('propagates repository failures', async () => {
    repo.save.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.create(owner, { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' }),
    ).rejects.toThrow('connection lost');
  });

  it('finds trips active on a date (inclusive bounds)', async () => {
    await service.findActiveOn('2026-11-03');

    expect(repo.find).toHaveBeenCalledWith({
      where: { startDate: LessThanOrEqual('2026-11-03'), endDate: MoreThanOrEqual('2026-11-03') },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  });
});

describe('toTripDto', () => {
  it('maps an entity to the contract Trip shape', () => {
    expect(toTripDto(makeTrip({ notes: 'beach' }))).toEqual({
      id: TRIP_ID,
      destination: 'Lisbon',
      startDate: '2026-11-01',
      endDate: '2026-11-05',
      notes: 'beach',
      createdAt: '2026-10-03T10:00:00.000Z',
    });
  });
});

describe('toTripDto contract shape', () => {
  it('exposes exactly the contract Trip fields', () => {
    expect(Object.keys(toTripDto(makeTrip())).sort()).toEqual(
      ['createdAt', 'destination', 'endDate', 'id', 'notes', 'startDate'].sort(),
    );
  });

  it('never leaks ownership or updatedAt', () => {
    const dto = toTripDto(makeTrip()) as Record<string, unknown>;

    expect(dto).not.toHaveProperty('provider');
    expect(dto).not.toHaveProperty('chatId');
    expect(dto).not.toHaveProperty('updatedAt');
  });

  it('normalizes undefined notes to null', () => {
    expect(toTripDto(makeTrip({ notes: undefined as unknown as null })).notes).toBeNull();
  });

  it('accepts createdAt hydrated as a string', () => {
    expect(toTripDto(makeTrip({ createdAt: '2026-10-03 10:00:00+00' as unknown as Date })).createdAt).toBe(
      '2026-10-03T10:00:00.000Z',
    );
  });
});
