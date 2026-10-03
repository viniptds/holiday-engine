import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateTripDto } from './create-trip.dto.js';
import { UpdateTripDto } from './update-trip.dto.js';
import { TripIdDto } from './trip-id.dto.js';

const TRIP_ID = '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70';

async function failedProps<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain));
  return errors.map((e) => e.property);
}

describe('CreateTripDto', () => {
  const valid = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };

  it('accepts a valid payload, with or without notes', async () => {
    expect(await failedProps(CreateTripDto, valid)).toEqual([]);
    expect(await failedProps(CreateTripDto, { ...valid, notes: 'x'.repeat(500) })).toEqual([]);
  });

  it('accepts a one-day trip (endDate == startDate)', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, endDate: '2026-11-01' })).toEqual([]);
  });

  it('rejects endDate before startDate', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, endDate: '2026-10-31' })).toEqual(['endDate']);
  });

  it('enforces destination length 1-100', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, destination: '' })).toEqual(['destination']);
    expect(await failedProps(CreateTripDto, { ...valid, destination: 'x'.repeat(101) })).toEqual(['destination']);
    expect(await failedProps(CreateTripDto, { ...valid, destination: 'x'.repeat(100) })).toEqual([]);
  });

  it('rejects notes over 500 chars', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, notes: 'x'.repeat(501) })).toEqual(['notes']);
  });

  it('requires YYYY-MM-DD real dates', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2026-11-01T00:00:00Z' })).toEqual(['startDate']);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '01/11/2026' })).toEqual(['startDate']);
    expect(await failedProps(CreateTripDto, { ...valid, endDate: '2026-02-30' })).toEqual(['endDate']);
  });

  it('requires all mandatory fields', async () => {
    expect((await failedProps(CreateTripDto, {})).sort()).toEqual(['destination', 'endDate', 'startDate']);
  });
});

describe('UpdateTripDto', () => {
  it('accepts a partial update', async () => {
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, destination: 'Porto' })).toEqual([]);
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, endDate: '2026-11-09' })).toEqual([]);
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, notes: null })).toEqual([]);
  });

  it('requires a uuid tripId', async () => {
    expect(await failedProps(UpdateTripDto, { destination: 'Porto' })).toEqual(['tripId']);
    expect(await failedProps(UpdateTripDto, { tripId: '123' })).toEqual(['tripId']);
  });

  it('rejects endDate before startDate when both are given', async () => {
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: '2026-11-05', endDate: '2026-11-01' }),
    ).toEqual(['endDate']);
  });

  it('enforces lengths and date format', async () => {
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, destination: '' })).toEqual(['destination']);
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, notes: 'x'.repeat(501) })).toEqual(['notes']);
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: 'tomorrow' })).toEqual(['startDate']);
  });
});

describe('TripIdDto', () => {
  it('requires a uuid tripId', async () => {
    expect(await failedProps(TripIdDto, { tripId: TRIP_ID })).toEqual([]);
    expect(await failedProps(TripIdDto, {})).toEqual(['tripId']);
  });
});
