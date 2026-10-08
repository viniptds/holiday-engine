import type { PresignedUpload } from './storage/object-storage.js';

/** `Moment` in the app API. `location` is only ever sent to the uploader. `url` is a signed GET (1 h), ready moments only. */
export type MomentDto = {
  id: string;
  tripId: string | null;
  status: 'pending' | 'ready';
  author: { userId: string; displayName: string; avatarUrl: string | null };
  mine: boolean;
  contentType: string;
  byteSize: number;
  width: number;
  height: number;
  takenAt: string;
  takenOn: string;
  location: { lat: number; lng: number } | null;
  url: string | null;
  createdAt: string;
};

export type CreatedMomentDto = { moment: MomentDto; upload: PresignedUpload };

export const MOMENT_CONTENT_TYPES = ['image/jpeg'] as const;
export const MAX_MOMENT_BYTES = 10 * 1024 * 1024;
export const MAX_UNASSIGNED_MOMENTS = 50;
export const UPLOAD_RATE_LIMIT = { max: 60, windowMs: 60 * 60 * 1000 };
/** Pending moments older than this are removed (with any object) by the cleanup. */
export const PENDING_MOMENT_TTL_MS = 60 * 60 * 1000;
export const PENDING_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
export const PENDING_CLEANUP_BATCH = 100;
