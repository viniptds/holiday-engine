import { addUtcDays, formatDateOnly, startOfUtcDay } from './events.dates.js';
import type { Event, EventsProvider, EventsSearch } from './events.types.js';

const EVENTS_PER_DAY = 3;

const TEMPLATES: { category: string; names: string[]; venues: (string | null)[] }[] = [
  {
    category: 'music',
    names: ['Jazz Night', 'Open-Air Concert', 'Indie Showcase', 'Symphony Evening', 'Samba Session'],
    venues: ['City Concert Hall', 'Riverside Stage', 'Blue Note Club', 'Old Town Amphitheatre'],
  },
  {
    category: 'food',
    names: ['Street Food Market', 'Wine Tasting', 'Farmers Market', 'Local Cuisine Workshop'],
    venues: ['Central Market', 'Harbour Square', 'Cellar Bistro', 'Old Warehouse'],
  },
  {
    category: 'art',
    names: ['Gallery Opening', 'Modern Art Tour', 'Photography Exhibition', 'Street Art Walk'],
    venues: ['Contemporary Art Museum', 'Gallery Row', 'Cultural Centre'],
  },
  {
    category: 'sports',
    names: ['Local Football Match', 'City Fun Run', 'Beach Volleyball Cup', 'Cycling Tour'],
    venues: ['Municipal Stadium', 'Seafront Promenade', 'City Park'],
  },
  {
    category: 'theatre',
    names: ['Comedy Night', 'Classic Play', 'Improv Show', 'Dance Performance'],
    venues: ['Royal Theatre', 'Little Stage', 'Arts Playhouse'],
  },
  {
    category: 'festival',
    names: ['Neighbourhood Festival', 'Lantern Parade', 'Craft Fair', 'Film Under the Stars'],
    venues: ['Main Square', 'Botanical Garden', null],
  },
];

/** FNV-1a 32-bit hash. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small seeded PRNG returning floats in [0, 1). */
function seededRandom(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Trimmed, single-spaced, title case ("  são   paulo" -> "São Paulo"), so casing never changes the events. */
export function normalizeCity(city: string): string {
  return city
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/(^|[\s-])(\p{L})/gu, (_, separator: string, letter: string) => separator + letter.toUpperCase());
}

function slug(text: string): string {
  const ascii = text.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return ascii.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'city';
}

/**
 * Deterministic fake events. Each (normalized city, day) pair always yields the same events,
 * so overlapping ranges agree and `externalId`s stay stable for dedupe.
 */
export class MockEventsProvider implements EventsProvider {
  async search({ city, from, to, limit }: EventsSearch): Promise<Event[]> {
    if (limit <= 0 || from > to) return [];

    const events: Event[] = [];
    // Days are visited in order and every event falls on its own day, so once `limit`
    // events are collected no later day can sort before them. This keeps long ranges cheap.
    for (let day = startOfUtcDay(from); day <= to && events.length < limit; day = addUtcDays(day, 1)) {
      events.push(
        ...this.eventsForDay(normalizeCity(city), day).filter((event) => {
          const startsAt = new Date(event.startsAt);
          return startsAt >= from && startsAt <= to;
        }),
      );
    }

    return events
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.externalId.localeCompare(b.externalId))
      .slice(0, limit);
  }

  private eventsForDay(city: string, day: Date): Event[] {
    const date = formatDateOnly(day);
    const random = seededRandom(hash(`${city}|${date}`));
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];

    return Array.from({ length: EVENTS_PER_DAY }, (_, index) => {
      const template = pick(TEMPLATES);
      const venue = pick(template.venues);
      // Between 10:00 and 22:45 UTC, in 15-minute steps.
      const minutes = 10 * 60 + Math.floor(random() * 52) * 15;
      const externalId = `mock-${slug(city)}-${date}-${index}`;
      return {
        externalId,
        name: `${pick(template.names)} in ${city}`,
        startsAt: new Date(day.getTime() + minutes * 60 * 1000).toISOString(),
        venue,
        city,
        url: random() < 0.7 ? `https://events.example.com/${externalId}` : null,
        category: template.category,
      };
    });
  }
}
