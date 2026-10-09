import { SUPPORTED_LOCALES } from '../app-common/locale.js';
import { copyProblems, countryName, fill, isEligible, loadCopy, monthName, parseCopyFile, placeholdersIn, routeText, wordCount } from './copy.js';
import type { CopyTemplate } from './copy.js';
import { BANNER_TIERS, BIG_TRIP_ANGLES } from './home.types.js';

const ok = (over: Partial<CopyTemplate> = {}): CopyTemplate => ({ headline: '{destination} this weekend', subline: '{distanceKm} km away and {tempC} °C today.', plannerPrompt: 'Plan a trip to {destination}.', ...over });
const six = (over: Partial<CopyTemplate> = {}) => Array.from({ length: 6 }, () => ok(over));

describe('home copy sets', () => {
  it('loads the bundled sets: 6-10 templates per tier and language, every bigTrip angle covered', () => {
    const copy = loadCopy();
    for (const tier of BANNER_TIERS) {
      for (const locale of SUPPORTED_LOCALES) {
        const templates = copy[tier][locale];
        expect(templates.length).toBeGreaterThanOrEqual(6);
        expect(templates.length).toBeLessThanOrEqual(10);
        for (const t of templates) {
          expect(wordCount(t.headline)).toBeLessThanOrEqual(6);
          expect(wordCount(t.subline)).toBeLessThanOrEqual(14);
          expect(copyProblems(t)).toEqual([]);
          expect(tier === 'bigTrip' ? BIG_TRIP_ANGLES : [undefined]).toContain(t.angle);
        }
        if (tier === 'bigTrip') for (const angle of BIG_TRIP_ANGLES) expect(templates.some((t) => t.angle === angle)).toBe(true);
      }
    }
  });

  it('enforces the copy rules', () => {
    expect(copyProblems({ headline: 'One two three four five six seven', subline: 'Fine.' })).toContain('headline has more than 6 words');
    expect(copyProblems({ headline: 'Porto now', subline: 'a b c d e f g h i j k l m n o' })).toContain('subline has more than 14 words');
    expect(copyProblems({ headline: 'Porto now!', subline: 'Fine.' })).toContain('exclamation marks are not allowed');
    expect(copyProblems({ headline: 'Amazing Porto', subline: 'Fine.' })).toContain('"amazing/incredible" are not allowed');
    expect(copyProblems({ headline: 'Porto 🌞', subline: 'Fine.' })).toContain('emoji are not allowed');
    expect(copyProblems({ headline: 'Porto now', subline: 'Soon...' })).toContain('use the … character, not three dots');
    expect(copyProblems({ headline: 'Porto, before the summer crowds', subline: 'A 2-hour train, mild 19 °C, your style of slow mornings.' })).toEqual([]);
  });

  it('fails startup validation naming every problem in a file', () => {
    expect(() => parseCopyFile({ templates: six().slice(0, 3) }, 'nearby')).toThrow(/needs 6-10 templates \(has 3\)/);
    const message = (() => {
      try {
        parseCopyFile({ templates: [ok({ headline: '{planet} in {month}' }), ok({ subline: 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen' }), ok({ angle: 'family' }), ok({ headline: 'Somewhere nice', plannerPrompt: 'Plan a trip.' }), ok(), ok()] }, 'nearby');
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain('templates[0].headline: unknown placeholder {planet}');
    expect(message).toContain('templates[1]: subline has more than 14 words');
    expect(message).toContain('templates[2].angle only applies to bigTrip templates');
    expect(message).toContain('templates[3]: the headline or planner prompt must name the place');
    expect(() => parseCopyFile({ templates: six({ angle: 'family' }) }, 'bigTrip')).toThrow(/no template for the business angle/);
    expect(() => parseCopyFile({ templates: six({ angle: 'everyone' as never }) }, 'bigTrip')).toThrow(/angle must be one of family, business, explorer/);
    expect(() => parseCopyFile({ nope: 1 }, 'nearby')).toThrow(/"templates" array/);
    expect(() => loadCopy('/nowhere/')).toThrow(/Invalid home copy set \(\/nowhere\/nearby\.en\.json\)/);
  });

  it('makes a template eligible only when every placeholder it uses has a value', () => {
    const template = ok({ subline: '{distanceKm} km, your kind of {persona}.' });
    expect(placeholdersIn(`${template.headline} ${template.subline}`)).toEqual(['destination', 'distanceKm', 'persona']);
    expect(isEligible(template, { destination: 'Porto', distanceKm: '274' })).toBe(false);
    expect(isEligible(template, { destination: 'Porto', distanceKm: '274', persona: 'slow mornings' })).toBe(true);
    expect(fill('{month} in {destination}', { month: 'november', destination: 'Porto' })).toBe('November in Porto');
    expect(fill(template.subline, { distanceKm: '274', persona: 'slow mornings' })).toBe('274 km, your kind of slow mornings.');
  });

  it('names countries, months and routes per language', () => {
    expect(countryName('PT', 'en')).toBe('Portugal');
    expect(countryName('NL', 'en')).toBe('the Netherlands');
    expect(countryName('BR', 'pt-BR')).toBe('o Brasil');
    expect(countryName('PT', 'pt-BR')).toBe('Portugal');
    expect(countryName('GB', 'es')).toBe('el Reino Unido');
    expect(countryName('AR', 'es')).toBe('Argentina');
    expect(monthName(11, 'en')).toBe('November');
    expect(monthName(11, 'pt-BR')).toBe('novembro');
    expect(monthName(11, 'es')).toBe('noviembre');
    expect(routeText(['Porto', 'Lisbon', 'Sintra'], 'en')).toBe('Porto, Lisbon and Sintra');
    expect(routeText(['Porto', 'Lisboa'], 'pt-BR')).toBe('Porto e Lisboa');
    expect(routeText(['Oporto', 'Lisboa', 'Sintra'], 'es')).toBe('Oporto, Lisboa y Sintra');
    expect(routeText(['Porto'], 'en')).toBe('Porto');
  });
});
