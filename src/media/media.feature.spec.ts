import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { bootMoments, EDITOR, OWNER } from '../moments/testing/harness.js';
import type { Harness } from '../moments/testing/harness.js';
import { MediaService } from './media.service.js';
import { MEDIA_FETCH } from './photo-source.js';
import type { PhotoDto } from './media.types.js';
import { RateWindow } from '../app-common/rate-window.js';
import { MEDIA_RATE_LIMIT } from './media.types.js';

const KEY = 'test-places-key-0123456789';
type Photos = { photos: PhotoDto[] };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const googlePhoto = (place: string, i: number, extra: Record<string, unknown> = {}) => ({
  name: `places/${place}/photos/ref${i}`,
  widthPx: 4000,
  heightPx: 3000,
  authorAttributions: [{ displayName: `Author ${i}`, uri: `https://maps.google.com/maps/contrib/${i}`, photoUri: '//lh3.googleusercontent.com/a' }],
  ...extra,
});

/** A fake Google: Text Search, Place Details and photo media, recording every call. */
class FakeGoogle {
  calls: { url: string; init?: RequestInit }[] = [];
  failing = false;
  photoUri = (name: string, width: string) => `https://lh3.googleusercontent.com/places/${encodeURIComponent(name)}=w${width}`;

  fetch = jest.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.calls.push({ url, init });
    if (this.failing) return json(503, { error: { message: `bad key ${KEY}` } });
    if (url === 'https://places.googleapis.com/v1/places:searchText') {
      const body = JSON.parse(String(init?.body)) as { textQuery: string };
      if (body.textQuery === 'Nowhere') return json(200, {});
      const mask = (init?.headers as Record<string, string>)['X-Goog-FieldMask'];
      if (mask === 'places.id,places.addressComponents') {
        return json(200, { places: [{ id: 'city-lisbon', addressComponents: [{ shortText: 'pt', types: ['country', 'political'] }] }] });
      }
      return json(200, { places: [{ id: 'city-lisbon', photos: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => googlePhoto('city-lisbon', i)) }] });
    }
    const details = url.match(/^https:\/\/places\.googleapis\.com\/v1\/places\/([^/?]+)$/);
    if (details) {
      if (details[1] === 'gone') return json(404, {});
      return json(200, { photos: [googlePhoto(details[1], 0, { widthPx: 300, heightPx: 200 }), googlePhoto(details[1], 1)] });
    }
    const media = url.match(/^https:\/\/places\.googleapis\.com\/v1\/(places\/[^?]+)\/media\?maxWidthPx=(\d+)&skipHttpRedirect=true$/);
    if (media) return json(200, { name: media[1], photoUri: this.photoUri(media[1], media[2]) });
    return json(500, {});
  });

  reset() {
    this.calls = [];
    this.failing = false;
    this.fetch.mockClear();
  }
}

describe('Media: city and place photos (feature)', () => {
  describe('with Google (mocked fetch)', () => {
    const google = new FakeGoogle();
    let h: Harness;
    const logged: string[] = [];

    beforeAll(async () => {
      h = await bootMoments({
        config: { PLACES_PROVIDER: 'google', GOOGLE_PLACES_API_KEY: KEY },
        customize: (builder) => builder.overrideProvider(MEDIA_FETCH).useValue(google.fetch),
      });
    });

    afterAll(async () => {
      await h.close();
    });

    beforeEach(() => {
      h.db.clear();
      h.seedUsers();
      google.reset();
      // The caches and the rate limit are per process: fresh ones per test.
      const service = h.moduleRef.get(MediaService);
      Object.assign(service, {
        lists: new (Object.getPrototypeOf((service as unknown as { lists: object }).lists).constructor)(5000, 86_400_000),
        uris: new (Object.getPrototypeOf((service as unknown as { uris: object }).uris).constructor)(20000, 43_200_000),
        rate: new RateWindow(MEDIA_RATE_LIMIT.max, MEDIA_RATE_LIMIT.windowMs, 'Too many photo requests. Please wait a little.'),
      });
      logged.length = 0;
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
      }
    });

    afterEach(() => jest.restoreAllMocks());

    it('returns city photos as googleusercontent URLs at 1200 px, never the media URL or the key', async () => {
      const res = await h.call('GET', '/media/city?q=Lisbon&count=3', OWNER);
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain('places.googleapis.com');
      const { photos } = JSON.parse(text) as Photos;
      expect(photos).toHaveLength(3);
      expect(photos[0]).toEqual({
        url: google.photoUri('places/city-lisbon/photos/ref0', '1200'),
        width: 1200,
        height: 900,
        attributions: [{ displayName: 'Author 0', uri: 'https://maps.google.com/maps/contrib/0' }],
      });
      const [search, ...media] = google.calls;
      expect(search.init?.headers).toMatchObject({ 'X-Goog-Api-Key': KEY, 'X-Goog-FieldMask': 'places.id,places.photos' });
      expect(JSON.parse(String(search.init?.body))).toEqual({ textQuery: 'Lisbon', pageSize: 1 });
      expect(media.map((c) => c.url)).toEqual([0, 1, 2].map((i) => `https://places.googleapis.com/v1/places/city-lisbon/photos/ref${i}/media?maxWidthPx=1200&skipHttpRedirect=true`));
      // The key goes in a header, never in a URL.
      expect(media.every((c) => !c.url.includes(KEY) && (c.init?.headers as Record<string, string>)['X-Goog-Api-Key'] === KEY)).toBe(true);
    });

    it('returns place photos (Place Details, field mask photos), thumbnails at 400 px, never upscaled', async () => {
      const res = await h.json<Photos>('GET', '/media/place/ChIJabc?count=5&size=thumb', OWNER);

      expect(res.status).toBe(200);
      expect(res.body.photos.map((p) => [p.width, p.height])).toEqual([
        [300, 200],
        [400, 300],
      ]);
      expect(google.calls[0].url).toBe('https://places.googleapis.com/v1/places/ChIJabc');
      expect(google.calls[0].init?.headers).toMatchObject({ 'X-Goog-FieldMask': 'photos' });
      expect(google.calls.slice(1).every((c) => c.url.includes('maxWidthPx=400'))).toBe(true);
    });

    it('caches the photo list (24 h) and the resolved URLs (12 h)', async () => {
      await h.json('GET', '/media/city?q=Lisbon&count=2', OWNER);
      const first = google.calls.length;
      const again = await h.json<Photos>('GET', '/media/city?q=lisbon&count=2', EDITOR);

      expect(again.body.photos).toHaveLength(2);
      expect(first).toBe(3);
      expect(google.calls.length).toBe(first);
      // A third photo resolves only that one; another size resolves again.
      await h.json('GET', '/media/city?q=Lisbon&count=3', OWNER);
      expect(google.calls.length).toBe(first + 1);
      await h.json('GET', '/media/city?q=Lisbon&count=1&size=thumb', OWNER);
      expect(google.calls.length).toBe(first + 2);
    });

    it('answers an empty list (and logs only the status) when Google fails, and tries again next time', async () => {
      google.failing = true;

      const city = await h.json<Photos>('GET', '/media/city?q=Lisbon', OWNER);
      const place = await h.json<Photos>('GET', '/media/place/ChIJabc', OWNER);

      expect([city, place]).toEqual([
        { status: 200, body: { photos: [] } },
        { status: 200, body: { photos: [] } },
      ]);
      expect(logged.join('\n')).toContain('HTTP 503');
      expect(logged.join('\n')).not.toContain(KEY);
      google.failing = false;
      expect((await h.json<Photos>('GET', '/media/city?q=Lisbon', OWNER)).body.photos).toHaveLength(1);
    });

    it('answers an empty list for an unknown place or a city without photos', async () => {
      expect((await h.json<Photos>('GET', '/media/place/gone', OWNER)).body).toEqual({ photos: [] });
      expect((await h.json<Photos>('GET', '/media/city?q=Nowhere', OWNER)).body).toEqual({ photos: [] });
      expect((await h.json<Photos>('GET', '/media/place/bad%20id', OWNER)).body).toEqual({ photos: [] });
    });

    it('drops a photoUri that would carry the key', async () => {
      google.photoUri = (name) => `https://lh3.googleusercontent.com/${name}?key=${KEY}`;
      try {
        const res = await h.call('GET', '/media/city?q=Lisbon&count=2', OWNER);
        expect(await res.text()).toBe('{"photos":[]}');
      } finally {
        google.photoUri = new FakeGoogle().photoUri;
      }
    });

    it('rate-limits each user to 300 photo requests an hour', async () => {
      for (let i = 0; i < 300; i++) expect((await h.call('GET', '/media/place/ChIJabc', OWNER)).status).toBe(200);

      const limited = await h.call('GET', '/media/city?q=Lisbon', OWNER);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(3000);
      expect((await h.call('GET', '/media/city?q=Lisbon', EDITOR)).status).toBe(200);
    });

    it.each([
      ['/media/city', 'q missing'],
      ['/media/city?q=Lisbon&count=7', 'count over 6'],
      ['/media/city?q=Lisbon&count=0', 'count under 1'],
      ['/media/place/ChIJabc?count=6', 'count over 5'],
      ['/media/place/ChIJabc?size=huge', 'an unknown size'],
    ])('refuses %s (%s) with VALIDATION', async (path) => {
      expect((await h.json(path.includes('city') ? 'GET' : 'GET', path, OWNER)).status).toBe(400);
    });

    it('needs a signed-in user', async () => {
      expect((await h.call('GET', '/media/city?q=Lisbon', null)).status).toBe(401);
    });
  });

  describe('with PLACES_PROVIDER=mock', () => {
    let h: Harness;

    beforeAll(async () => {
      h = await bootMoments();
    });

    afterAll(async () => {
      await h.close();
    });

    beforeEach(() => {
      h.db.clear();
      h.seedUsers();
    });

    it('returns deterministic picsum URLs with a mock credit', async () => {
      const city = await h.json<Photos>('GET', '/media/city?q=Lisbon, Portugal&count=2', OWNER);
      const place = await h.json<Photos>('GET', '/media/place/mock-abc?count=1&size=thumb', OWNER);

      expect(city.body.photos).toEqual([
        { url: 'https://picsum.photos/seed/city-lisbon-0/1200/800', width: 1200, height: 800, attributions: [{ displayName: 'Mock photographer', uri: 'https://picsum.photos' }] },
        { url: 'https://picsum.photos/seed/city-lisbon-1/1200/800', width: 1200, height: 800, attributions: [{ displayName: 'Mock photographer', uri: 'https://picsum.photos' }] },
      ]);
      expect(place.body.photos.map((p) => p.url)).toEqual(['https://picsum.photos/seed/mock-abc-0/400/267']);
      expect((await h.json<Photos>('GET', '/media/place/mock-missing-1', OWNER)).body).toEqual({ photos: [] });
    });
  });
});
