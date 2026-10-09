import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { DOWNLOAD_URL_TTL_SECONDS, OBJECT_KEY, UPLOAD_URL_TTL_SECONDS } from './object-storage.js';
import type { ObjectStorage, PresignedUpload, StorageRequestContext, StoredObject } from './object-storage.js';

/** What a `/files/:token` URL allows: one operation on one key until `exp` (ms). */
export type FileGrant = { k: string; m: 'PUT' | 'GET'; exp: number; ct?: string; n?: number };

export const FILES_PATH = 'app/v1/files';

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** Thrown for a token that is malformed, forged, expired or for another operation. */
export class InvalidFileTokenError extends Error {}
/** Thrown when an upload is bigger than its grant allows. */
export class UploadTooLargeError extends Error {}

/**
 * DEV ONLY (`STORAGE_DRIVER=local`, refused in production): files under `./storage/`, served by the
 * engine itself at `/app/v1/files/:token`. Tokens are HMAC-signed, single-key, single-operation and
 * expire like S3's presigned URLs (PUT 15 min, GET 1 h).
 */
export class LocalObjectStorage implements ObjectStorage {
  readonly driver = 'local' as const;
  private readonly root: string;

  constructor(
    dir: string,
    private readonly secret: Buffer,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(dir);
  }

  async presignUpload(key: string, file: { contentType: string; byteSize: number }, context: StorageRequestContext): Promise<PresignedUpload> {
    const exp = this.now() + UPLOAD_URL_TTL_SECONDS * 1000;
    const token = this.sign({ k: key, m: 'PUT', exp, ct: file.contentType, n: file.byteSize });
    return {
      url: `${context.baseUrl}/${FILES_PATH}/${token}`,
      method: 'PUT',
      headers: { 'Content-Type': file.contentType },
      expiresAt: new Date(exp).toISOString(),
    };
  }

  async presignDownload(key: string, context: StorageRequestContext): Promise<string> {
    return `${context.baseUrl}/${FILES_PATH}/${this.sign({ k: key, m: 'GET', exp: this.now() + DOWNLOAD_URL_TTL_SECONDS * 1000 })}`;
  }

  async stat(key: string): Promise<StoredObject | null> {
    try {
      const info = await stat(this.path(key));
      const contentType = await readFile(`${this.path(key)}.type`, 'utf8').catch(() => null);
      return { size: info.size, contentType };
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.path(key), { force: true });
    await rm(`${this.path(key)}.type`, { force: true });
  }

  async readStart(key: string, length: number): Promise<Buffer | null> {
    let handle;
    try {
      handle = await open(this.path(key), 'r');
    } catch {
      return null;
    }
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async setContentType(key: string, contentType: string): Promise<void> {
    await writeFile(`${this.path(key)}.type`, contentType);
  }

  /** The grant a token carries, if it's genuine, unexpired and for `method`. */
  verify(token: string, method: 'PUT' | 'GET'): FileGrant {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) throw new InvalidFileTokenError('malformed');
    const expected = this.mac(payload);
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InvalidFileTokenError('bad signature');
    let grant: FileGrant;
    try {
      grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as FileGrant;
    } catch {
      throw new InvalidFileTokenError('malformed');
    }
    if (grant.m !== method || typeof grant.k !== 'string' || !OBJECT_KEY.test(grant.k)) throw new InvalidFileTokenError('wrong grant');
    if (typeof grant.exp !== 'number' || grant.exp <= this.now()) throw new InvalidFileTokenError('expired');
    return grant;
  }

  /** Stores an upload for a PUT grant, refusing more than `grant.n` bytes. Written atomically. */
  async write(grant: FileGrant, contentType: string | null, body: Readable): Promise<number> {
    const target = this.path(grant.k);
    await mkdir(dirname(target), { recursive: true });
    const limit = grant.n ?? 0;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new UploadTooLargeError(`more than ${limit} bytes`);
      chunks.push(chunk as Buffer);
    }
    const temp = `${target}.${randomUUID()}.part`;
    await writeFile(temp, Buffer.concat(chunks));
    await rename(temp, target);
    await writeFile(`${target}.type`, (contentType ?? '').split(';')[0].trim().toLowerCase());
    return size;
  }

  /** A read stream for a GET grant's file, with its type, or null if it's gone. */
  async read(grant: FileGrant): Promise<{ stream: Readable; size: number; contentType: string } | null> {
    const object = await this.stat(grant.k);
    if (!object) return null;
    return { stream: createReadStream(this.path(grant.k)), size: object.size, contentType: object.contentType || 'application/octet-stream' };
  }

  private sign(grant: FileGrant): string {
    const payload = b64url(JSON.stringify(grant));
    return `${payload}.${b64url(this.mac(payload))}`;
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.secret).update(payload).digest();
  }

  /** Engine-generated keys only (no `..`), so the path always stays under the root. */
  private path(key: string): string {
    if (!OBJECT_KEY.test(key)) throw new InvalidFileTokenError('bad key');
    return join(this.root, key);
  }
}

/** The local driver's signing key, derived from JWT_SECRET (so no extra setting). */
export const localStorageSecret = (jwtSecret: string) => createHmac('sha256', jwtSecret).update('holidai:local-storage:v1').digest();
