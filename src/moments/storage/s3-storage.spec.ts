import { jest } from '@jest/globals';
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3ObjectStorage } from './s3-storage.js';
import type { Presign, S3Like } from './s3-storage.js';

const KEY = 'moments/u/m.jpg';
const NOW = Date.parse('2026-10-08T12:00:00Z');

function stub(response: (command: unknown) => unknown) {
  const send = jest.fn(async (command: unknown) => response(command));
  const presign = jest.fn<Presign>(async (_client, command, options) => `https://r2.test/${(command.input as { Key: string }).Key}?X-Amz-Expires=${options.expiresIn}`);
  const storage = new S3ObjectStorage('photos', { send } as unknown as S3Like, presign, () => NOW);
  return { send, presign, storage };
}

describe('S3ObjectStorage (STORAGE_DRIVER=s3, stub client)', () => {
  it('presigns a PUT for 15 minutes with the type and length signed', async () => {
    const { presign, storage } = stub(() => ({}));

    const upload = await storage.presignUpload(KEY, { contentType: 'image/jpeg', byteSize: 1234 });

    expect(upload).toEqual({
      url: `https://r2.test/${KEY}?X-Amz-Expires=900`,
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      expiresAt: '2026-10-08T12:15:00.000Z',
    });
    const [, command, options] = presign.mock.calls[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({ Bucket: 'photos', Key: KEY, ContentType: 'image/jpeg', ContentLength: 1234 });
    expect(options).toEqual({ expiresIn: 900, signableHeaders: new Set(['content-type']) });
  });

  it('signs content-type in the real presigned PUT, so S3 refuses an upload without it or with another type', async () => {
    // The real presigner, offline (fake credentials; signing needs no network).
    const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'example-secret' } });
    const storage = new S3ObjectStorage('photos', client, getSignedUrl as never, () => NOW);

    const { url, headers } = await storage.presignUpload(KEY, { contentType: 'image/jpeg', byteSize: 282518 });

    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host');
    expect(headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(url).not.toContain('example-secret');
    client.destroy();
  });

  it('presigns a GET for 1 hour', async () => {
    const { presign, storage } = stub(() => ({}));

    expect(await storage.presignDownload(KEY)).toBe(`https://r2.test/${KEY}?X-Amz-Expires=3600`);
    expect(presign.mock.calls[0][1]).toBeInstanceOf(GetObjectCommand);
    expect(presign.mock.calls[0][1].input).toEqual({ Bucket: 'photos', Key: KEY });
  });

  it('reads the size and type with HEAD; a missing object is null; other errors throw', async () => {
    const found = stub(() => ({ ContentLength: 2048, ContentType: 'image/jpeg' }));
    expect(await found.storage.stat(KEY)).toEqual({ size: 2048, contentType: 'image/jpeg' });
    expect(found.send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect((found.send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({ Bucket: 'photos', Key: KEY });

    const missing = stub(() => {
      throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    });
    expect(await missing.storage.stat(KEY)).toBeNull();

    const down = stub(() => {
      throw Object.assign(new Error('Service unavailable'), { $metadata: { httpStatusCode: 503 } });
    });
    await expect(down.storage.stat(KEY)).rejects.toThrow('Service unavailable');
  });

  it('reads the first bytes with a ranged GET; a missing object is null', async () => {
    const { send, storage } = stub(() => ({ Body: { transformToByteArray: async () => new Uint8Array([0xff, 0xd8, 0xff]) } }));

    expect(await storage.readStart(KEY, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[0][0] as GetObjectCommand).input).toEqual({ Bucket: 'photos', Key: KEY, Range: 'bytes=0-2' });

    const missing = stub(() => {
      throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    });
    expect(await missing.storage.readStart(KEY, 3)).toBeNull();
  });

  it('fixes the stored type with CopyObject onto itself (metadata REPLACE)', async () => {
    const { send, storage } = stub(() => ({}));

    await storage.setContentType('moments/u 1/m.jpg', 'image/jpeg');

    expect(send.mock.calls[0][0]).toBeInstanceOf(CopyObjectCommand);
    expect((send.mock.calls[0][0] as CopyObjectCommand).input).toEqual({
      Bucket: 'photos',
      Key: 'moments/u 1/m.jpg',
      CopySource: 'photos/moments/u%201/m.jpg',
      ContentType: 'image/jpeg',
      MetadataDirective: 'REPLACE',
    });
  });

  it('deletes with DeleteObject', async () => {
    const { send, storage } = stub(() => ({}));

    await storage.delete(KEY);

    expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[0][0] as DeleteObjectCommand).input).toEqual({ Bucket: 'photos', Key: KEY });
  });
});
