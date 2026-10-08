import { localIsoDate } from './timezone.js';

describe('localIsoDate', () => {
  it.each([
    ['UTC', '2026-10-08T23:30:00Z', '2026-10-08'],
    ['America/Sao_Paulo', '2026-10-09T02:30:00Z', '2026-10-08'],
    ['Pacific/Auckland', '2026-10-08T11:30:00Z', '2026-10-09'],
    ['Europe/Madrid', '2026-03-29T00:30:00Z', '2026-03-29'],
  ])('%s at %s is %s', (zone, instant, date) => {
    expect(localIsoDate(zone, new Date(instant))).toBe(date);
  });
});
