import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../app-common/auth-user.js';
import { RateWindow } from '../app-common/rate-window.js';
import { TtlLru } from '../app-common/ttl-lru.js';
import { normalizeName } from '../ai/draft.js';
import { PHOTO_SOURCE } from './photo-source.js';
import type { PhotoRef, PhotoSource } from './photo-source.js';
import {
  MEDIA_RATE_LIMIT,
  PHOTO_LIST_CACHE_SIZE,
  PHOTO_LIST_TTL_MS,
  PHOTO_URI_CACHE_SIZE,
  PHOTO_URI_TTL_MS,
  PHOTO_WIDTHS,
} from './media.types.js';
import type { PhotoDto, PhotoSize } from './media.types.js';

/**
 * City and place photos (docs/app-moments-spec.md §1). Images are decorative: a Google failure
 * gives an empty list, never an error. Only the resolved `photoUri` (googleusercontent, no key)
 * reaches clients.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly lists = new TtlLru<string, PhotoRef[]>(PHOTO_LIST_CACHE_SIZE, PHOTO_LIST_TTL_MS);
  private readonly uris = new TtlLru<string, string | null>(PHOTO_URI_CACHE_SIZE, PHOTO_URI_TTL_MS);
  private readonly rate = new RateWindow(MEDIA_RATE_LIMIT.max, MEDIA_RATE_LIMIT.windowMs, 'Too many photo requests. Please wait a little.');

  constructor(@Inject(PHOTO_SOURCE) private readonly source: PhotoSource) {}

  async city(user: AuthUser, query: string, count: number, size: PhotoSize): Promise<PhotoDto[]> {
    this.rate.take(user.id);
    return this.cityPhotos(query, count, size);
  }

  /** City photos for the engine's own use (Home banners): the same caches, no per-user rate limit. */
  async cityPhotos(query: string, count: number, size: PhotoSize): Promise<PhotoDto[]> {
    const refs = await this.list(`city:${normalizeName(query)}`, () => this.source.cityPhotos(query.trim()), 'city');
    return this.resolve(refs.slice(0, count), PHOTO_WIDTHS[size]);
  }

  async place(user: AuthUser, googlePlaceId: string, count: number, size: PhotoSize): Promise<PhotoDto[]> {
    this.rate.take(user.id);
    const refs = await this.list(`place:${googlePlaceId}`, () => this.source.placePhotos(googlePlaceId), 'place');
    return this.resolve(refs.slice(0, count), PHOTO_WIDTHS[size]);
  }

  /** Cached photo refs; a failed lookup is logged (status only) and gives [] without being cached. */
  private async list(key: string, load: () => Promise<PhotoRef[]>, kind: string): Promise<PhotoRef[]> {
    const cached = this.lists.get(key);
    if (cached) return cached;
    try {
      const refs = await load();
      this.lists.set(key, refs);
      return refs;
    } catch (error) {
      this.logger.warn(`Photos: ${kind} lookup failed (${this.source.name}): ${(error as Error).message}`);
      return [];
    }
  }

  private async resolve(refs: PhotoRef[], maxWidthPx: number): Promise<PhotoDto[]> {
    const photos = await Promise.all(
      refs.map(async (ref): Promise<PhotoDto | null> => {
        const key = `${ref.name}|${maxWidthPx}`;
        let url = this.uris.get(key);
        if (url === undefined) {
          try {
            url = await this.source.photoUri(ref, maxWidthPx);
            this.uris.set(key, url);
          } catch (error) {
            this.logger.warn(`Photos: photo lookup failed (${this.source.name}): ${(error as Error).message}`);
            return null;
          }
        }
        if (!url) return null;
        const width = ref.widthPx ? Math.min(maxWidthPx, ref.widthPx) : maxWidthPx;
        const height = ref.widthPx && ref.heightPx ? Math.round((ref.heightPx * width) / ref.widthPx) : Math.round((width * 2) / 3);
        return { url, width, height, attributions: ref.attributions };
      }),
    );
    return photos.filter((p): p is PhotoDto => p !== null);
  }
}
