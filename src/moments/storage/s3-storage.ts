import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DOWNLOAD_URL_TTL_SECONDS, UPLOAD_URL_TTL_SECONDS } from './object-storage.js';
import type { ObjectStorage, PresignedUpload, StoredObject } from './object-storage.js';
import type { S3Settings } from './storage.config.js';

/** The part of S3Client the driver uses (tests pass a stub). */
export type S3Like = Pick<S3Client, 'send'>;
/** `getSignedUrl` from `@aws-sdk/s3-request-presigner` (tests pass a stub). */
export type Presign = (client: S3Like, command: PutObjectCommand | GetObjectCommand, options: { expiresIn: number }) => Promise<string>;

export function createS3Client(settings: S3Settings): S3Client {
  return new S3Client({
    region: settings.region,
    ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
}

const isNotFound = (error: unknown) => {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
};

/**
 * `STORAGE_DRIVER=s3`: any S3-compatible endpoint (S3, R2, MinIO). The bucket stays private: uploads
 * use presigned PUTs (15 min, type and length signed) and reads presigned GETs (1 h).
 */
export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;

  constructor(
    private readonly bucket: string,
    private readonly client: S3Like,
    private readonly presign: Presign = getSignedUrl as unknown as Presign,
    private readonly now: () => number = Date.now,
  ) {}

  async presignUpload(key: string, file: { contentType: string; byteSize: number }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: file.contentType, ContentLength: file.byteSize });
    const url = await this.presign(this.client, command, { expiresIn: UPLOAD_URL_TTL_SECONDS });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': file.contentType },
      expiresAt: new Date(this.now() + UPLOAD_URL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  async presignDownload(key: string): Promise<string> {
    return this.presign(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const head = (await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))) as { ContentLength?: number; ContentType?: string };
      return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
