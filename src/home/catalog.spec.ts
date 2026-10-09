import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import { DestinationCatalog, distanceKm, loadCatalog, parseCatalog } from './catalog.js';

const entry = (over: Record<string, unknown> = {}) => ({
  id: 'porto',
  names: { en: 'Porto', 'pt-BR': 'Porto', es: 'Oporto' },
  country: 'PT',
  aliases: ['porto', 'oporto'],
  tags: ['city', 'food'],
  bestMonths: [5, 6, 9],
  similar: [],
  popularity: 4,
  lat: 41.15,
  lng: -8.61,
  kind: 'city',
  ...over,
});
const many = (n: number) => Array.from({ length: n }, (_, i) => entry({ id: `city-${i}`, aliases: [`city ${i}`], similar: [], lat: -10 - i, lng: 120 }));

describe('destination catalog', () => {
  it('loads the bundled catalog: about 80 entries with every locale, coordinates and a kind', () => {
    const catalog = loadCatalog();
    expect(catalog.destinations.length).toBeGreaterThanOrEqual(80);
    for (const d of catalog.destinations) {
      for (const locale of SUPPORTED_LOCALES) expect(d.names[locale]).toBeTruthy();
      expect(['city', 'region', 'island']).toContain(d.kind);
      expect(Math.abs(d.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(d.lng)).toBeLessThanOrEqual(180);
      for (const s of d.similar) expect(catalog.get(s)).toBeDefined();
    }
  });

  it('fails startup validation naming every problem', () => {
    const bad = many(25);
    bad[0] = entry({ id: 'city-0', names: { en: 'Porto', 'pt-BR': 'Porto' }, lat: 123, kind: 'town', tags: ['city', 'moon'] });
    bad[3] = entry({ id: 'city-3', aliases: ['city 3'], similar: ['nowhere'] });
    bad[1] = entry({ id: 'city-1', bestMonths: [0, 13] });
    bad[2] = entry({ id: 'city-3', aliases: ['again'] });
    const message = (() => {
      try {
        parseCatalog({ destinations: bad });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('names is missing "es"');
    expect(message).toContain('lat must be a number between -90 and 90');
    expect(message).toContain('kind must be one of city, region, island');
    expect(message).toContain('unknown tag "moon"');
    expect(message).toContain('similar "nowhere" is not in the catalog');
    expect(message).toContain('bestMonths must be a non-empty array of months 1-12');
    expect(message).toContain('destination id "city-3" is used more than once');
    expect(() => parseCatalog({ destinations: many(3) })).toThrow(/at least 20 destinations/);
    expect(() => parseCatalog({ nope: [] })).toThrow(/"destinations" array/);
    expect(() => loadCatalog('/nowhere/destinations.json')).toThrow(/Invalid destination catalog \(\/nowhere\/destinations.json\)/);
  });

  it('matches free-text destinations by alias and name, ignoring accents, case and a country suffix', () => {
    const catalog = loadCatalog();
    expect(catalog.match('Porto')?.id).toBe('porto');
    expect(catalog.match('OPORTO')?.id).toBe('porto');
    expect(catalog.match('Río de Janeiro')?.id).toBe('rio-de-janeiro');
    expect(catalog.match('rio')?.id).toBe('rio-de-janeiro');
    expect(catalog.match('Lisbon, Portugal')?.id).toBe('lisbon');
    expect(catalog.match('São Paulo - SP')?.id).toBe('sao-paulo');
    expect(catalog.match('Atlantis')).toBeUndefined();
    expect(catalog.match(null)).toBeUndefined();
  });

  it('measures distances and finds the nearest entry within a radius', () => {
    const catalog = new DestinationCatalog(parseCatalog({ destinations: [...many(20), entry(), entry({ id: 'lisbon', names: { en: 'Lisbon', 'pt-BR': 'Lisboa', es: 'Lisboa' }, aliases: ['lisbon'], lat: 38.72, lng: -9.14 })] }));
    expect(distanceKm({ lat: 38.72, lng: -9.14 }, { lat: 41.15, lng: -8.61 })).toBeGreaterThan(260);
    expect(distanceKm({ lat: 38.72, lng: -9.14 }, { lat: 41.15, lng: -8.61 })).toBeLessThan(290);
    expect(catalog.nearest({ lat: 38.75, lng: -9.2 }, 30)?.destination.id).toBe('lisbon');
    expect(catalog.nearest({ lat: 40.0, lng: -9.0 }, 30)).toBeUndefined();
    expect(catalog.nearest({ lat: 40.0, lng: -9.0 }, 300)?.destination.id).toBe('porto');
  });
});
