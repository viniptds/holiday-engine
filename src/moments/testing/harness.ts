/** TEST ONLY: boots the Moments features over HTTP for feature specs. */
import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Trip } from '../../trips/trip.entity.js';
import { TripMember } from '../../app-trips/trip-member.entity.js';
import type { TripRole } from '../../app-trips/app-trips.types.js';
import { UserEntitlement } from '../../billing/user-entitlement.entity.js';
import { accessTokens, seedUser } from '../../testing/app-testing.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import type { ObjectStorage } from '../storage/object-storage.js';
import { momentsDb, momentsTestingModule } from './moments-testing.js';

export const OWNER = '11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const EDITOR = '22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const VIEWER = '33333333-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const OTHER = '44444444-1f2b-4c3d-8e9f-0a1b2c3d4e5f';
export const USERS = [OWNER, EDITOR, VIEWER, OTHER];

export const DAY_MS = 86_400_000;
/** `YYYY-MM-DD` `offset` days from today (UTC). */
export const isoDay = (offset = 0, from = Date.now()) => new Date(from + offset * DAY_MS).toISOString().slice(0, 10);

export type Harness = {
  app: INestApplication;
  moduleRef: TestingModule;
  db: InMemoryDb;
  baseUrl: string;
  call: (method: string, path: string, user: string | null, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  json: <T = Record<string, unknown>>(method: string, path: string, user: string | null, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: T }>;
  seedUsers: () => void;
  seedTrip: (members?: [string, TripRole][], fields?: Partial<Trip>) => Trip;
  grantPlus: (userId: string) => void;
  close: () => Promise<void>;
};

export async function bootMoments(
  options: { config?: Record<string, string>; storage?: ObjectStorage; customize?: (builder: ReturnType<typeof momentsTestingModule>) => ReturnType<typeof momentsTestingModule> } = {},
): Promise<Harness> {
  const db = momentsDb();
  let builder = momentsTestingModule(db, options.config, options.storage);
  if (options.customize) builder = options.customize(builder);
  const moduleRef = await builder.compile();
  const tokens = await accessTokens(moduleRef, USERS);
  const app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  const baseUrl = `${await app.getUrl()}/app/v1`;

  const call: Harness['call'] = (method, path, user, body, headers = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(user ? { authorization: `Bearer ${tokens[user]}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const json: Harness['json'] = async (method, path, user, body, headers) => {
    const response = await call(method, path, user, body, headers);
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : null) as never };
  };

  return {
    app,
    moduleRef,
    db,
    baseUrl,
    call,
    json,
    seedUsers: () => {
      for (const id of USERS) seedUser(db, id);
    },
    seedTrip: (members = [[OWNER, 'owner']], fields = {}) => {
      const trip = db.seed(Trip, {
        provider: null,
        chatId: null,
        ownerUserId: members[0][0],
        destination: 'Lisbon',
        startDate: isoDay(30),
        endDate: isoDay(32),
        notes: null,
        story: null,
        partyType: null,
        partySize: null,
        travelerProfile: null,
        countryCode: null,
        cityPlaceId: null,
        ...fields,
      });
      for (const [userId, role] of members) db.seed(TripMember, { tripId: trip.id, userId, role });
      return trip;
    },
    grantPlus: (userId) => {
      db.seed(UserEntitlement, { userId, entitlement: 'plus', store: 'dev', status: 'active', expiresAt: null });
    },
    close: () => app.close(),
  };
}
