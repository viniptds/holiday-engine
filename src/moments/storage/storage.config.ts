/** Storage settings (`.env.example`, docs/app-moments-spec.md §2). */
export const STORAGE_DRIVERS = ['local', 's3'] as const;
export type StorageDriverName = (typeof STORAGE_DRIVERS)[number];

export type S3Settings = {
  endpoint: string | undefined;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
};

export type StorageConfig = {
  driver: StorageDriverName;
  /** `local`: the directory files live in (`./storage`, gitignored). */
  localDir: string;
  s3: S3Settings | null;
  freeMomentsPerTrip: number;
  plusMomentsPerTrip: number;
};

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
export const DEFAULT_LOCAL_STORAGE_DIR = 'storage';

type Env = Record<string, string | undefined>;
const value = (env: Env, key: string) => env[key]?.trim() || undefined;

function count(env: Env, key: string, fallback: number): number {
  const raw = value(env, key);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100_000) throw new Error(`${key} must be a whole number from 1 to 100000 (got "${raw}")`);
  return parsed;
}

/**
 * Reads STORAGE_DRIVER (default local) and its settings. Fails startup on `local` in production, an
 * unknown driver, missing S3 settings (names only, never values) or bad limits.
 */
export function readStorageConfig(env: Env): StorageConfig {
  const driver = (value(env, 'STORAGE_DRIVER') ?? 'local').toLowerCase();
  if (!(STORAGE_DRIVERS as readonly string[]).includes(driver)) {
    throw new Error(`Unknown STORAGE_DRIVER "${driver}". Use one of: ${STORAGE_DRIVERS.join(', ')}.`);
  }
  if (driver === 'local' && value(env, 'NODE_ENV') === 'production') {
    throw new Error('STORAGE_DRIVER=local is not allowed in production; use s3');
  }
  let s3: S3Settings | null = null;
  if (driver === 's3') {
    const missing = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((key) => !value(env, key));
    if (missing.length > 0) throw new Error(`STORAGE_DRIVER=s3 needs these settings, which are missing or empty: ${missing.join(', ')}. See .env.example.`);
    const pathStyle = (value(env, 'S3_FORCE_PATH_STYLE') ?? 'false').toLowerCase();
    if (pathStyle !== 'true' && pathStyle !== 'false') throw new Error(`S3_FORCE_PATH_STYLE must be true or false (got "${pathStyle}")`);
    const endpoint = value(env, 'S3_ENDPOINT');
    if (endpoint && !/^https?:\/\//.test(endpoint)) throw new Error('S3_ENDPOINT must be an http(s) URL');
    s3 = {
      endpoint,
      region: value(env, 'S3_REGION') ?? 'auto',
      bucket: value(env, 'S3_BUCKET')!,
      accessKeyId: value(env, 'S3_ACCESS_KEY_ID')!,
      secretAccessKey: value(env, 'S3_SECRET_ACCESS_KEY')!,
      forcePathStyle: pathStyle === 'true',
    };
  }
  const freeMomentsPerTrip = count(env, 'FREE_MOMENTS_PER_TRIP', 50);
  const plusMomentsPerTrip = count(env, 'PLUS_MOMENTS_PER_TRIP', 1000);
  return {
    driver: driver as StorageDriverName,
    localDir: value(env, 'STORAGE_LOCAL_DIR') ?? DEFAULT_LOCAL_STORAGE_DIR,
    s3,
    freeMomentsPerTrip,
    plusMomentsPerTrip,
  };
}
