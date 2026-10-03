import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from './trip-member.entity.js';
import { AppTripsService } from './app-trips.service.js';
import { StubUserDirectory } from './stub-user-directory.js';
import type { TripRole } from './app-trips.types.js';

const TRIP_ID = '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';
const ME = { id: '7d0c5a8e-1f2b-4c3d-8e9f-0a1b2c3d4e5f', email: 'me@example.com' };
const userId = (n: number) => `${String(n).padStart(8, '0')}-1f2b-4c3d-8e9f-0a1b2c3d4e5f`;

function makeTrip(overrides: Partial<Trip> = {}): Trip {
  return Object.assign(new Trip(), {
    id: TRIP_ID,
    provider: null,
    chatId: null,
    ownerUserId: ME.id,
    destination: 'Lisbon',
    startDate: '2026-11-01',
    endDate: '2026-11-05',
    notes: 'old notes',
    story: 'old story',
    partyType: 'couple',
    partySize: 2,
    travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] }, persona: null },
    createdAt: new Date('2026-10-03T10:00:00.000Z'),
    updatedAt: new Date('2026-10-03T11:00:00.000Z'),
    ...overrides,
  });
}

function makeMember(user: string, role: TripRole, joinedAt = '2026-10-03T10:00:00.000Z', tripId = TRIP_ID): TripMember {
  return Object.assign(new TripMember(), { tripId, userId: user, role, joinedAt: new Date(joinedAt) });
}

const membershipOf = (role: TripRole, trip = makeTrip()) => Object.assign(makeMember(ME.id, role), { trip });

describe('AppTripsService', () => {
  let service: AppTripsService;
  const manager = {
    create: jest.fn((cls: new () => object, data: object) => Object.assign(new cls(), data)),
    save: jest.fn(async (entity: object): Promise<object> => {
      if (entity instanceof Trip) {
        return Object.assign(entity, {
          id: TRIP_ID,
          createdAt: new Date('2026-10-03T10:00:00.000Z'),
          updatedAt: new Date('2026-10-03T10:00:00.000Z'),
        });
      }
      return Object.assign(entity, { joinedAt: new Date('2026-10-03T10:00:00.000Z') });
    }),
  };
  const transaction = jest.fn(async (work: (m: typeof manager) => Promise<unknown>) => work(manager));
  const trips = {
    save: jest.fn(async (trip: Trip) => trip),
    delete: jest.fn(async (_criteria: object) => ({ affected: 1 })),
    manager: { transaction },
  };
  const members = {
    find: jest.fn(async (_options: object): Promise<TripMember[]> => []),
    findOne: jest.fn(async (_options: object): Promise<TripMember | null> => null),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Drop queued once-values that a rejected call didn't consume.
    members.find.mockReset().mockResolvedValue([]);
    members.findOne.mockReset().mockResolvedValue(null);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppTripsService,
        { provide: getRepositoryToken(Trip), useValue: trips },
        { provide: getRepositoryToken(TripMember), useValue: members },
        { provide: USER_DIRECTORY, useClass: StubUserDirectory },
      ],
    }).compile();
    service = moduleRef.get(AppTripsService);
  });

  /** The membership lookup returns `membership`; the member listing returns `all` (or just that membership). */
  function given(membership: TripMember | null, all?: TripMember[]) {
    members.findOne.mockResolvedValueOnce(membership);
    if (membership) members.find.mockResolvedValueOnce(all ?? [membership]);
  }

  describe('create', () => {
    const data = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };

    it('saves the trip and the owner membership with the same transactional manager', async () => {
      members.find.mockResolvedValueOnce([makeMember(ME.id, 'owner')]);

      await service.create(ME, data);

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledTimes(2);
      const [[trip], [member]] = manager.save.mock.calls;
      expect(trip).toBeInstanceOf(Trip);
      expect(trip).toEqual(
        expect.objectContaining({ provider: null, chatId: null, ownerUserId: ME.id, destination: 'Lisbon' }),
      );
      expect(member).toBeInstanceOf(TripMember);
      expect(member).toEqual(expect.objectContaining({ tripId: TRIP_ID, userId: ME.id, role: 'owner' }));
      // Nothing is written outside the transaction.
      expect(trips.save).not.toHaveBeenCalled();
    });

    it('defaults the optional fields to null', async () => {
      members.find.mockResolvedValueOnce([makeMember(ME.id, 'owner')]);

      await service.create(ME, data);

      expect(manager.save.mock.calls[0][0]).toMatchObject({
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
      });
    });

    it('stores the optional fields, with a null persona on the traveler profile', async () => {
      members.find.mockResolvedValueOnce([makeMember(ME.id, 'owner')]);
      const answers = { pace: ['slow'], interests: ['food'] };

      const dto = await service.create(ME, {
        ...data,
        notes: 'n',
        story: 's',
        partyType: 'family',
        partySize: 4,
        travelerProfile: { questionSetVersion: 1, answers },
      });

      expect(manager.save.mock.calls[0][0]).toMatchObject({
        notes: 'n',
        story: 's',
        partyType: 'family',
        partySize: 4,
        travelerProfile: { questionSetVersion: 1, answers, persona: null },
      });
      expect(dto.travelerProfile).toEqual({ questionSetVersion: 1, answers, persona: null });
    });

    it('returns the trip with the caller as its only member and owner', async () => {
      members.find.mockResolvedValueOnce([makeMember(ME.id, 'owner')]);

      const dto = await service.create(ME, data);

      expect(dto).toMatchObject({
        id: TRIP_ID,
        myRole: 'owner',
        memberCount: 1,
        members: [{ userId: ME.id, displayName: 'Traveler 7d0c', avatarUrl: null, role: 'owner' }],
      });
      expect(members.find).toHaveBeenCalledWith({ where: { tripId: In([TRIP_ID]) } });
    });

    it('fails without a response when the membership insert fails (the transaction rolls back)', async () => {
      manager.save.mockImplementationOnce(async (trip) => trip).mockRejectedValueOnce(new Error('insert failed'));

      await expect(service.create(ME, data)).rejects.toThrow('insert failed');
      expect(members.find).not.toHaveBeenCalled();
      expect(trips.save).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('queries the user memberships with their trips, by startDate', async () => {
      await expect(service.list(ME)).resolves.toEqual([]);

      expect(members.find).toHaveBeenCalledWith({
        where: { userId: ME.id },
        relations: { trip: true },
        order: { trip: { startDate: 'ASC', createdAt: 'ASC' } },
      });
      expect(members.find).toHaveBeenCalledTimes(1);
    });

    it('keeps the query order and reports my role on each trip', async () => {
      const second = '1b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';
      members.find
        .mockResolvedValueOnce([
          membershipOf('viewer', makeTrip({ startDate: '2026-11-01' })),
          Object.assign(makeMember(ME.id, 'editor', undefined, second), {
            trip: makeTrip({ id: second, startDate: '2026-12-01', endDate: '2026-12-02' }),
          }),
        ])
        .mockResolvedValueOnce([
          makeMember(userId(1), 'owner'),
          makeMember(ME.id, 'viewer'),
          makeMember(userId(2), 'owner', undefined, second),
          makeMember(ME.id, 'editor', undefined, second),
        ]);

      const result = await service.list(ME);

      expect(result.map((t) => [t.id, t.myRole, t.memberCount])).toEqual([
        [TRIP_ID, 'viewer', 2],
        [second, 'editor', 2],
      ]);
      expect(members.find).toHaveBeenLastCalledWith({ where: { tripId: In([TRIP_ID, second]) } });
    });
  });

  describe('get', () => {
    it.each<TripRole>(['owner', 'editor', 'viewer'])('returns the trip to a %s', async (role) => {
      given(membershipOf(role));

      await expect(service.get(ME, TRIP_ID)).resolves.toMatchObject({ id: TRIP_ID, myRole: role });
      expect(members.findOne).toHaveBeenCalledWith({ where: { tripId: TRIP_ID, userId: ME.id }, relations: { trip: true } });
    });

    it('is NOT_FOUND for a non-member', async () => {
      given(null);

      await expect(service.get(ME, TRIP_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it.each(['nope', '00000000-0000-0000-0000-000000000000', `${TRIP_ID}x`])(
      'is NOT_FOUND for the malformed id %s, without querying',
      async (id) => {
        await expect(service.get(ME, id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(members.findOne).not.toHaveBeenCalled();
      },
    );

    it('lists the first 5 members, owner first then by join date, and counts them all', async () => {
      const all = [
        makeMember(userId(1), 'viewer', '2026-10-05T00:00:00.000Z'),
        makeMember(userId(2), 'editor', '2026-10-04T00:00:00.000Z'),
        makeMember(userId(3), 'viewer', '2026-10-09T00:00:00.000Z'),
        makeMember(userId(4), 'editor', '2026-10-06T00:00:00.000Z'),
        makeMember(ME.id, 'owner', '2026-10-03T00:00:00.000Z'),
        makeMember(userId(5), 'viewer', '2026-10-07T00:00:00.000Z'),
        makeMember(userId(6), 'viewer', '2026-10-08T00:00:00.000Z'),
      ];
      // The owner may also have joined later (ownership transfer); they still come first.
      all[4].joinedAt = new Date('2026-10-10T00:00:00.000Z');
      given(membershipOf('owner'), all);

      const dto = await service.get(ME, TRIP_ID);

      expect(dto.memberCount).toBe(7);
      expect(dto.members.map((m) => [m.userId, m.role])).toEqual([
        [ME.id, 'owner'],
        [userId(2), 'editor'],
        [userId(1), 'viewer'],
        [userId(4), 'editor'],
        [userId(5), 'viewer'],
      ]);
      expect(dto.members[1]).toEqual({ userId: userId(2), displayName: 'Traveler 0000', avatarUrl: null, role: 'editor' });
    });

    it('returns exactly the contract Trip fields, with ISO timestamps', async () => {
      given(membershipOf('editor'));

      const dto = await service.get(ME, TRIP_ID);

      expect(dto).toEqual({
        id: TRIP_ID,
        destination: 'Lisbon',
        startDate: '2026-11-01',
        endDate: '2026-11-05',
        notes: 'old notes',
        story: 'old story',
        partyType: 'couple',
        partySize: 2,
        travelerProfile: { questionSetVersion: 1, answers: { pace: ['slow'] }, persona: null },
        myRole: 'editor',
        members: [{ userId: ME.id, displayName: 'Traveler 7d0c', avatarUrl: null, role: 'editor' }],
        memberCount: 1,
        createdAt: '2026-10-03T10:00:00.000Z',
        updatedAt: '2026-10-03T11:00:00.000Z',
      });
    });
  });

  describe('update', () => {
    it.each<TripRole>(['owner', 'editor'])('lets a %s edit', async (role) => {
      given(membershipOf(role));

      const dto = await service.update(ME, TRIP_ID, { destination: 'Porto' });

      expect(dto).toMatchObject({ destination: 'Porto', myRole: role });
      expect(trips.save).toHaveBeenCalledWith(expect.objectContaining({ id: TRIP_ID, destination: 'Porto' }));
    });

    it('is FORBIDDEN for a viewer', async () => {
      given(membershipOf('viewer'));

      await expect(service.update(ME, TRIP_ID, { destination: 'Porto' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(trips.save).not.toHaveBeenCalled();
    });

    it('is NOT_FOUND for a non-member', async () => {
      given(null);

      await expect(service.update(ME, TRIP_ID, { destination: 'Porto' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(trips.save).not.toHaveBeenCalled();
    });

    it('clears the nullable fields on null', async () => {
      given(membershipOf('owner'));

      const dto = await service.update(ME, TRIP_ID, {
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
      });

      expect(dto).toMatchObject({ notes: null, story: null, partyType: null, partySize: null, travelerProfile: null });
    });

    it('keeps omitted fields', async () => {
      given(membershipOf('owner'));

      const dto = await service.update(ME, TRIP_ID, { partySize: 3 });

      expect(dto).toMatchObject({ destination: 'Lisbon', notes: 'old notes', story: 'old story', partyType: 'couple', partySize: 3 });
    });

    it('replaces the traveler profile, resetting the persona', async () => {
      given(membershipOf('owner', makeTrip({ travelerProfile: { questionSetVersion: 1, answers: {}, persona: 'Foodie' } })));

      const dto = await service.update(ME, TRIP_ID, { travelerProfile: { questionSetVersion: 1, answers: { pace: ['fast'] } } });

      expect(dto.travelerProfile).toEqual({ questionSetVersion: 1, answers: { pace: ['fast'] }, persona: null });
    });

    it('rejects an endDate before the stored startDate', async () => {
      given(membershipOf('owner'));

      await expect(service.update(ME, TRIP_ID, { endDate: '2026-10-31' })).rejects.toMatchObject({
        code: 'VALIDATION',
        fields: { endDate: 'endDate must be on or after startDate' },
      });
      expect(trips.save).not.toHaveBeenCalled();
    });

    it('applies the 365-day cap against the stored dates', async () => {
      given(membershipOf('owner'));
      await expect(service.update(ME, TRIP_ID, { startDate: '2025-11-04' })).rejects.toMatchObject({
        code: 'VALIDATION',
        fields: { startDate: 'endDate must be at most 365 days after startDate' },
      });

      given(membershipOf('owner'));
      await expect(service.update(ME, TRIP_ID, { endDate: '2027-11-02' })).rejects.toMatchObject({
        code: 'VALIDATION',
        fields: { endDate: 'endDate must be at most 365 days after startDate' },
      });

      given(membershipOf('owner'));
      await expect(service.update(ME, TRIP_ID, { startDate: '2025-11-05' })).resolves.toMatchObject({
        startDate: '2025-11-05',
        endDate: '2026-11-05',
      });
      expect(trips.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('lets the owner delete the trip', async () => {
      given(membershipOf('owner'));

      await service.delete(ME, TRIP_ID);

      expect(trips.delete).toHaveBeenCalledWith({ id: TRIP_ID });
    });

    it.each<TripRole>(['editor', 'viewer'])('is FORBIDDEN for an %s', async (role) => {
      given(membershipOf(role));

      await expect(service.delete(ME, TRIP_ID)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(trips.delete).not.toHaveBeenCalled();
    });

    it('is NOT_FOUND for a non-member', async () => {
      given(null);

      await expect(service.delete(ME, TRIP_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(trips.delete).not.toHaveBeenCalled();
    });
  });
});
