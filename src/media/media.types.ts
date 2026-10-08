/** One photo for the app: a public image URL (never the Places API key) with its size and credits. */
export type PhotoDto = {
  url: string;
  width: number;
  height: number;
  attributions: { displayName: string; uri: string | null }[];
};

export const PHOTO_SIZES = ['large', 'thumb'] as const;
export type PhotoSize = (typeof PHOTO_SIZES)[number];
/** maxWidthPx per size: carousels and thumbnails. */
export const PHOTO_WIDTHS: Record<PhotoSize, number> = { large: 1200, thumb: 400 };

export const MAX_CITY_PHOTOS = 6;
export const MAX_PLACE_PHOTOS = 5;
/** Per user, both media endpoints together. */
export const MEDIA_RATE_LIMIT = { max: 300, windowMs: 60 * 60 * 1000 };
/** place (or city) → photo names: 24 h; photo name + width → photoUri: 12 h. In memory, per process. */
export const PHOTO_LIST_TTL_MS = 24 * 60 * 60 * 1000;
export const PHOTO_URI_TTL_MS = 12 * 60 * 60 * 1000;
export const PHOTO_LIST_CACHE_SIZE = 5_000;
export const PHOTO_URI_CACHE_SIZE = 20_000;
