import { isValidTimeZone, localDayBounds, requestTimeZone } from './timezone.js';

const bounds = (zone: string, iso: string) => {
  const { start, end } = localDayBounds(zone, new Date(iso));
  return [start.toISOString(), end.toISOString()];
};

describe('isValidTimeZone', () => {
  it.each(['America/Sao_Paulo', 'Europe/Madrid', 'Pacific/Auckland', 'UTC', 'Etc/GMT+3'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['', 'Mars/Olympus', 'America/Sao Paulo', 'Europe/Madrid\n', 'x'.repeat(65), 42, null, undefined])('rejects %p', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
  });
});

describe('localDayBounds (local midnight to local midnight, DST-safe)', () => {
  it('America/Sao_Paulo (UTC-3, no DST today)', () => {
    expect(bounds('America/Sao_Paulo', '2026-10-08T12:00:00Z')).toEqual(['2026-10-08T03:00:00.000Z', '2026-10-09T03:00:00.000Z']);
    // 23:30 local is still the same day; 00:30 local the next one.
    expect(bounds('America/Sao_Paulo', '2026-10-09T02:30:00Z')[0]).toBe('2026-10-08T03:00:00.000Z');
    expect(bounds('America/Sao_Paulo', '2026-10-09T03:30:00Z')[0]).toBe('2026-10-09T03:00:00.000Z');
  });

  it('America/Sao_Paulo on 2018-11-04, when DST skipped midnight: the day starts at 01:00 and lasts 23 h', () => {
    expect(bounds('America/Sao_Paulo', '2018-11-04T12:00:00Z')).toEqual(['2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z']);
  });

  it('Europe/Madrid across both DST changes (23 h and 25 h days)', () => {
    expect(bounds('Europe/Madrid', '2026-03-29T12:00:00Z')).toEqual(['2026-03-28T23:00:00.000Z', '2026-03-29T22:00:00.000Z']);
    expect(bounds('Europe/Madrid', '2026-10-25T12:00:00Z')).toEqual(['2026-10-24T22:00:00.000Z', '2026-10-25T23:00:00.000Z']);
  });

  it('Pacific/Auckland across both DST changes, on the other side of the date line', () => {
    expect(bounds('Pacific/Auckland', '2026-09-27T00:00:00Z')).toEqual(['2026-09-26T12:00:00.000Z', '2026-09-27T11:00:00.000Z']);
    expect(bounds('Pacific/Auckland', '2026-04-05T00:00:00Z')).toEqual(['2026-04-04T11:00:00.000Z', '2026-04-05T12:00:00.000Z']);
  });

  it('UTC', () => {
    expect(bounds('UTC', '2026-10-08T23:59:59.999Z')).toEqual(['2026-10-08T00:00:00.000Z', '2026-10-09T00:00:00.000Z']);
  });
});

describe('requestTimeZone', () => {
  const request = (header: string | undefined, stored: string | null = null) => ({
    headers: header === undefined ? {} : { 'x-timezone': header },
    user: { id: 'u', email: 'e', timezone: stored },
  });

  it('uses a valid X-Timezone, else the stored zone, else UTC', () => {
    expect(requestTimeZone(request(' Europe/Madrid ', 'America/Sao_Paulo'))).toBe('Europe/Madrid');
    expect(requestTimeZone(request('Nowhere/Land', 'America/Sao_Paulo'))).toBe('America/Sao_Paulo');
    expect(requestTimeZone(request(undefined, 'Pacific/Auckland'))).toBe('Pacific/Auckland');
    expect(requestTimeZone(request(undefined))).toBe('UTC');
    expect(requestTimeZone(request('Nowhere/Land', 'Also/Bad'))).toBe('UTC');
  });
});
