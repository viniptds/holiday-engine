import { readStorageConfig } from './storage.config.js';

const S3 = { STORAGE_DRIVER: 's3', S3_REGION: 'eu-west-1', S3_BUCKET: 'photos', S3_ACCESS_KEY_ID: 'AKIA', S3_SECRET_ACCESS_KEY: 'very-secret-value' };

describe('readStorageConfig', () => {
  it('defaults to local storage under ./storage and 50 / 1000 photos per trip', () => {
    expect(readStorageConfig({})).toEqual({ driver: 'local', localDir: 'storage', s3: null, freeMomentsPerTrip: 50, plusMomentsPerTrip: 1000 });
  });

  it('refuses local storage in production', () => {
    expect(() => readStorageConfig({ NODE_ENV: 'production' })).toThrow('STORAGE_DRIVER=local is not allowed in production; use s3');
    expect(() => readStorageConfig({ NODE_ENV: 'production', STORAGE_DRIVER: 'local' })).toThrow('not allowed in production');
    expect(readStorageConfig({ NODE_ENV: 'production', ...S3 }).driver).toBe('s3');
  });

  it('reads the S3 settings, virtual-hosted style by default', () => {
    expect(readStorageConfig(S3).s3).toEqual({
      endpoint: undefined,
      region: 'eu-west-1',
      bucket: 'photos',
      accessKeyId: 'AKIA',
      secretAccessKey: 'very-secret-value',
      forcePathStyle: false,
    });
    expect(readStorageConfig({ ...S3, S3_ENDPOINT: 'http://localhost:9000', S3_FORCE_PATH_STYLE: 'true', S3_REGION: 'us-east-1' }).s3).toMatchObject({
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      region: 'us-east-1',
    });
  });

  it.each([
    ['region auto', { S3_REGION: 'auto' }],
    ['region AUTO', { S3_REGION: 'AUTO' }],
    ['no region', { S3_REGION: '' }],
  ])("refuses AWS (no S3_ENDPOINT) with %s: 'auto' is for Cloudflare R2", (_label, fields) => {
    expect(() => readStorageConfig({ ...S3, ...fields })).toThrow(
      "S3_REGION must be your bucket's AWS region (e.g. us-east-1) when S3_ENDPOINT is empty; 'auto' is for Cloudflare R2",
    );
  });

  it('allows region auto with an endpoint (R2)', () => {
    expect(readStorageConfig({ ...S3, S3_REGION: 'auto', S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com' }).s3).toMatchObject({ region: 'auto' });
  });

  it('names the missing S3 settings, never values', () => {
    const error = (() => {
      try {
        readStorageConfig({ STORAGE_DRIVER: 's3', S3_SECRET_ACCESS_KEY: 'very-secret-value' });
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(error).toBe('STORAGE_DRIVER=s3 needs these settings, which are missing or empty: S3_BUCKET, S3_ACCESS_KEY_ID. See .env.example.');
  });

  it.each([
    [{ STORAGE_DRIVER: 'gcs' }, 'Unknown STORAGE_DRIVER "gcs". Use one of: local, s3.'],
    [{ ...S3, S3_FORCE_PATH_STYLE: 'yes' }, 'S3_FORCE_PATH_STYLE must be true or false'],
    [{ ...S3, S3_ENDPOINT: 'r2.example.com' }, 'S3_ENDPOINT must be an http(s) URL'],
    [{ FREE_MOMENTS_PER_TRIP: '0' }, 'FREE_MOMENTS_PER_TRIP must be a whole number from 1 to 100000 (got "0")'],
    [{ PLUS_MOMENTS_PER_TRIP: '1.5' }, 'PLUS_MOMENTS_PER_TRIP must be a whole number'],
  ])('fails on %j', (env, message) => {
    expect(() => readStorageConfig(env)).toThrow(message);
  });

  it('reads the limits', () => {
    expect(readStorageConfig({ FREE_MOMENTS_PER_TRIP: '20', PLUS_MOMENTS_PER_TRIP: '500' })).toMatchObject({ freeMomentsPerTrip: 20, plusMomentsPerTrip: 500 });
  });
});
