import { appValidationPipe } from '../../app-common/app-validation.pipe.js';
import { AppError } from '../../app-common/app-error.js';
import { CreateAppTripDto } from './create-app-trip.dto.js';
import { UpdateAppTripDto } from './update-app-trip.dto.js';

// Validates exactly as the controller does (whitelist, forbidNonWhitelisted, transform).
async function fieldErrors(metatype: new () => object, body: unknown): Promise<string[]> {
  try {
    await appValidationPipe.transform(body, { type: 'body', metatype });
    return [];
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe('VALIDATION');
    return Object.keys(error.fields ?? {}).sort();
  }
}

const create = (body: object) => fieldErrors(CreateAppTripDto, body);
const update = (body: object) => fieldErrors(UpdateAppTripDto, body);

const valid = { destination: 'Lisbon', startDate: '2026-11-01', endDate: '2026-11-05' };
const profile = { questionSetVersion: 1, answers: { pace: ['slow'], interests: ['food', 'museums'] } };
const full = { ...valid, notes: 'beach', story: 'Our first trip', partyType: 'couple', partySize: 2, travelerProfile: profile };

describe('CreateAppTripDto', () => {
  it('accepts the minimal and the full request', async () => {
    expect(await create(valid)).toEqual([]);
    expect(await create(full)).toEqual([]);
  });

  it('requires destination and both dates', async () => {
    expect(await create({})).toEqual(['destination', 'endDate', 'startDate']);
  });

  it('enforces destination 1-100 characters, trimmed', async () => {
    expect(await create({ ...valid, destination: '   ' })).toEqual(['destination']);
    expect(await create({ ...valid, destination: 'x'.repeat(101) })).toEqual(['destination']);
    expect(await create({ ...valid, destination: 'x'.repeat(100) })).toEqual([]);
    const dto = (await appValidationPipe.transform(
      { ...valid, destination: '  Lisbon ' },
      { type: 'body', metatype: CreateAppTripDto },
    )) as CreateAppTripDto;
    expect(dto.destination).toBe('Lisbon');
  });

  it('requires strict, real, ordered dates', async () => {
    expect(await create({ ...valid, startDate: '2026-11-01T00:00:00Z' })).toEqual(['startDate']);
    expect(await create({ ...valid, endDate: '2026-02-30' })).toEqual(['endDate']);
    expect(await create({ ...valid, endDate: '2026-10-31' })).toEqual(['endDate']);
    expect(await create({ ...valid, endDate: '2026-11-01' })).toEqual([]);
  });

  it('caps the trip at 365 days', async () => {
    expect(await create({ ...valid, startDate: '2026-01-01', endDate: '2027-01-01' })).toEqual([]);
    expect(await create({ ...valid, startDate: '2026-01-01', endDate: '2027-01-02' })).toEqual(['endDate']);
  });

  it('limits notes to 500 and story to 1000 characters', async () => {
    expect(await create({ ...valid, notes: 'x'.repeat(500), story: 'x'.repeat(1000) })).toEqual([]);
    expect(await create({ ...valid, notes: 'x'.repeat(501) })).toEqual(['notes']);
    expect(await create({ ...valid, story: 'x'.repeat(1001) })).toEqual(['story']);
  });

  it('rejects control characters but allows tab/LF/CR in notes and story', async () => {
    expect(await create({ ...valid, destination: 'Lis\u0000bon' })).toEqual(['destination']);
    expect(await create({ ...valid, notes: 'a\u001bb' })).toEqual(['notes']);
    expect(await create({ ...valid, story: 'a\u0007b' })).toEqual(['story']);
    expect(await create({ ...valid, notes: 'a\tb\r\nc', story: 'line 1\nline 2' })).toEqual([]);
  });

  it.each(['solo', 'couple', 'family', 'friends', 'work'])('accepts partyType %s', async (partyType) => {
    expect(await create({ ...valid, partyType })).toEqual([]);
  });

  it('rejects other party types', async () => {
    expect(await create({ ...valid, partyType: 'team' })).toEqual(['partyType']);
    expect(await create({ ...valid, partyType: 'Solo' })).toEqual(['partyType']);
  });

  it('accepts partySize 1-20 integers only', async () => {
    expect(await create({ ...valid, partySize: 1 })).toEqual([]);
    expect(await create({ ...valid, partySize: 20 })).toEqual([]);
    for (const partySize of [0, 21, 2.5, '3']) {
      expect(await create({ ...valid, partySize })).toEqual(['partySize']);
    }
  });

  it('checks the travelerProfile shape', async () => {
    expect(await create({ ...valid, travelerProfile: { questionSetVersion: 1, answers: {} } })).toEqual([]);
    expect(await create({ ...valid, travelerProfile: 'x' })).toEqual(['travelerProfile']);
    expect(await create({ ...valid, travelerProfile: { answers: {} } })).toEqual(['travelerProfile.questionSetVersion']);
    expect(await create({ ...valid, travelerProfile: { ...profile, answers: { pace: 'slow' } } })).toEqual([
      'travelerProfile.answers',
    ]);
    expect(await create({ ...valid, travelerProfile: { ...profile, answers: { pace: [1] } } })).toEqual([
      'travelerProfile.answers',
    ]);
    expect(await create({ ...valid, travelerProfile: { ...profile, answers: [['slow']] } })).toEqual([
      'travelerProfile.answers',
    ]);
  });

  it('rejects a client-sent persona and unknown fields', async () => {
    expect(await create({ ...valid, travelerProfile: { ...profile, persona: 'Foodie' } })).toEqual([
      'travelerProfile.persona',
    ]);
    expect(await create({ ...valid, ownerUserId: '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70' })).toEqual(['ownerUserId']);
    expect(await create({ ...valid, chatId: '1' })).toEqual(['chatId']);
  });
});

describe('UpdateAppTripDto', () => {
  it('accepts an empty and a partial update', async () => {
    expect(await update({})).toEqual([]);
    expect(await update({ destination: 'Porto' })).toEqual([]);
    expect(await update({ endDate: '2026-11-09' })).toEqual([]);
  });

  it.each(['notes', 'story', 'partyType', 'partySize', 'travelerProfile'])('accepts %s: null (clears it)', async (field) => {
    expect(await update({ [field]: null })).toEqual([]);
  });

  it.each(['destination', 'startDate', 'endDate'])('rejects %s: null', async (field) => {
    expect(await update({ [field]: null })).toEqual([field]);
  });

  it('reports the type error first for a wrong type', async () => {
    const message = async (body: object) => {
      const error = await appValidationPipe
        .transform(body, { type: 'body', metatype: UpdateAppTripDto })
        .catch((e: AppError) => e);
      return Object.values((error as AppError).fields ?? {})[0];
    };

    expect(await message({ destination: null })).toBe('destination must be a string');
    expect(await message({ notes: 5 })).toBe('notes must be a string');
    expect(await message({ partySize: '3' })).toBe('partySize must be an integer number');
    expect(await message({ travelerProfile: 'x' })).toBe('travelerProfile must be an object');
  });

  it('checks order and the 365-day cap when both dates are sent', async () => {
    expect(await update({ startDate: '2026-11-05', endDate: '2026-11-01' })).toEqual(['endDate']);
    expect(await update({ startDate: '2026-01-01', endDate: '2027-01-01' })).toEqual([]);
    expect(await update({ startDate: '2026-01-01', endDate: '2027-01-02' })).toEqual(['endDate']);
  });

  it('applies the same field rules as create', async () => {
    expect(await update({ destination: ' ' })).toEqual(['destination']);
    expect(await update({ startDate: 'tomorrow' })).toEqual(['startDate']);
    expect(await update({ story: 'x'.repeat(1001) })).toEqual(['story']);
    expect(await update({ partyType: 'crew' })).toEqual(['partyType']);
    expect(await update({ partySize: 21 })).toEqual(['partySize']);
    expect(await update({ travelerProfile: { questionSetVersion: 0, answers: {} } })).toEqual([
      'travelerProfile.questionSetVersion',
    ]);
    expect(await update({ id: '0b4f8c1e-3c2a-4f7e-9d1a-2b3c4d5e6f70' })).toEqual(['id']);
  });
});
