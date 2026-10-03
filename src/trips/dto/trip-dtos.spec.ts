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

describe('CreateTripDto edge cases', () => {
  const valid = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };

  it('accepts leap days only in leap years', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2028-02-29', endDate: '2028-03-01' })).toEqual([]);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2027-02-29', endDate: '2027-03-01' })).toEqual([
      'startDate',
    ]);
  });

  it('accepts trips spanning a year boundary', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2026-12-30', endDate: '2027-01-02' })).toEqual([]);
  });

  it('rejects non-string field types', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, destination: 42 })).toEqual(['destination']);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: 20261101 })).toEqual(['startDate']);
    expect(await failedProps(CreateTripDto, { ...valid, notes: 5 })).toEqual(['notes']);
  });

  it('accepts notes: null', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, notes: null })).toEqual([]);
  });

  it('counts length in characters, not bytes', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, destination: 'São Paulo'.padEnd(100, 'ã') })).toEqual([]);
  });

  // Regression for BUG-004 (whitespace-only destinations used to pass @IsNotEmpty).
  it('rejects a whitespace-only destination', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, destination: '   ' })).toEqual(['destination']);
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, destination: ' \t ' })).toEqual(['destination']);
  });

  it('trims the destination that gets stored', () => {
    expect(plainToInstance(CreateTripDto, { ...valid, destination: '  Lisbon ' }).destination).toBe('Lisbon');
  });
});

describe('UpdateTripDto edge cases', () => {
  it('accepts an update with only tripId (no-op)', async () => {
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID })).toEqual([]);
  });

  it('accepts equal start and end dates', async () => {
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: '2026-11-05', endDate: '2026-11-05' }),
    ).toEqual([]);
  });

  it('rejects impossible calendar dates', async () => {
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, endDate: '2026-04-31' })).toEqual(['endDate']);
  });

  // BUG-003 (fixed): @IsOptional() also skipped validation for null, so null reached NOT NULL columns.
  it.each(['destination', 'startDate', 'endDate'])('rejects %s: null', async (field) => {
    expect(await failedProps(UpdateTripDto, { tripId: TRIP_ID, [field]: null })).toEqual([field]);
  });
});

describe('contract rules added with Task D', () => {
  const valid = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };

  // BUG-005: a malformed startDate is reported once, without a spurious endDate error.
  it('reports only the malformed date, not the date order', async () => {
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: 'tomorrow', endDate: '2026-11-01' }),
    ).toEqual(['startDate']);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2026-02-30' })).toEqual(['startDate']);
  });

  // BUG-006: tripId must be a v4 UUID.
  it.each(['00000000-0000-0000-0000-000000000000', '0b4f8c1e-3c2a-1f7e-9d1a-2b3c4d5e6f70'])(
    'rejects the non-v4 tripId %s',
    async (tripId) => {
      expect(await failedProps(TripIdDto, { tripId })).toEqual(['tripId']);
      expect(await failedProps(UpdateTripDto, { tripId })).toEqual(['tripId']);
    },
  );

  // BUG-008: a trip may last at most 365 days.
  it('caps the trip length at 365 days', async () => {
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2026-01-01', endDate: '2027-01-01' })).toEqual([]);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2026-01-01', endDate: '2027-01-02' })).toEqual([
      'endDate',
    ]);
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: '2026-11-01', endDate: '9999-12-31' }),
    ).toEqual(['endDate']);
  });

  it('counts the 365-day cap in calendar days across a leap day', async () => {
    // 2028 is a leap year: 2027-03-01 -> 2028-03-01 is 366 days.
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2027-03-01', endDate: '2028-02-29' })).toEqual([]);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2027-03-01', endDate: '2028-03-01' })).toEqual([
      'endDate',
    ]);
    expect(await failedProps(CreateTripDto, { ...valid, startDate: '2028-01-01', endDate: '2028-12-31' })).toEqual([]);
  });

  it('applies the cap to an update that sends both dates', async () => {
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: '2026-01-01', endDate: '2027-01-01' }),
    ).toEqual([]);
    expect(
      await failedProps(UpdateTripDto, { tripId: TRIP_ID, startDate: '2026-01-01', endDate: '2027-01-02' }),
    ).toEqual(['endDate']);
  });

  it('explains which date rule failed', async () => {
    const [tooLong] = await validate(plainToInstance(CreateTripDto, { ...valid, endDate: '2028-01-01' }));
    const [reversed] = await validate(plainToInstance(CreateTripDto, { ...valid, endDate: '2026-10-01' }));

    expect(Object.values(tooLong.constraints!)).toEqual(['endDate must be at most 365 days after startDate']);
    expect(Object.values(reversed.constraints!)).toEqual(['endDate must be on or after startDate']);
  });
});
