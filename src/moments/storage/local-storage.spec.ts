import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { InvalidFileTokenError, LocalObjectStorage, UploadTooLargeError, localStorageSecret } from './local-storage.js';

const KEY = 'moments/11111111-1f2b-4c3d-8e9f-0a1b2c3d4e5f/22222222-1f2b-4c3d-8e9f-0a1b2c3d4e5f.jpg';
const CONTEXT = { baseUrl: 'http://localhost:3001' };
const tokenOf = (url: string) => url.split('/files/')[1];

describe('LocalObjectStorage (STORAGE_DRIVER=local)', () => {
  let dir: string;
  let now: number;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holidai-storage-'));
    now = Date.parse('2026-10-08T12:00:00Z');
    storage = new LocalObjectStorage(dir, localStorageSecret('a-jwt-secret-that-is-long-enough-000000'), () => now);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('signs a PUT URL on the engine for 15 minutes and a GET URL for 1 hour', async () => {
    const upload = await storage.presignUpload(KEY, { contentType: 'image/jpeg', byteSize: 3 }, CONTEXT);

    expect(upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, expiresAt: '2026-10-08T12:15:00.000Z' });
    expect(upload.url.startsWith('http://localhost:3001/app/v1/files/')).toBe(true);
    expect(storage.verify(tokenOf(upload.url), 'PUT')).toMatchObject({ k: KEY, m: 'PUT', ct: 'image/jpeg', n: 3 });

    const download = await storage.presignDownload(KEY, CONTEXT);
    expect(storage.verify(tokenOf(download), 'GET')).toMatchObject({ k: KEY, exp: Date.parse('2026-10-08T13:00:00Z') });
  });

  it('refuses expired URLs', async () => {
    const put = tokenOf((await storage.presignUpload(KEY, { contentType: 'image/jpeg', byteSize: 3 }, CONTEXT)).url);
    const get = tokenOf(await storage.presignDownload(KEY, CONTEXT));

    now += 15 * 60_000;
    expect(() => storage.verify(put, 'PUT')).toThrow(InvalidFileTokenError);
    expect(storage.verify(get, 'GET').k).toBe(KEY);
    now += 45 * 60_000;
    expect(() => storage.verify(get, 'GET')).toThrow('expired');
  });

  it('refuses a token for the other operation, a tampered one, one signed with another secret, and junk', async () => {
    const get = tokenOf(await storage.presignDownload(KEY, CONTEXT));
    const [payload, signature] = get.split('.');
    const forged = Buffer.from(JSON.stringify({ k: KEY, m: 'GET', exp: now + 1e9 })).toString('base64url');
    const other = new LocalObjectStorage(dir, localStorageSecret('another-secret-entirely-000000000000'), () => now);

    expect(() => storage.verify(get, 'PUT')).toThrow('wrong grant');
    expect(() => storage.verify(`${forged}.${signature}`, 'GET')).toThrow('bad signature');
    const foreign = tokenOf(await other.presignDownload(KEY, CONTEXT));
    expect(() => storage.verify(foreign, 'GET')).toThrow('bad signature');
    expect(() => storage.verify(payload, 'GET')).toThrow('malformed');
    expect(() => storage.verify(`${get}.x`, 'GET')).toThrow('malformed');
  });

  it('stores an upload, reports it, serves it and deletes it', async () => {
    const grant = storage.verify(tokenOf((await storage.presignUpload(KEY, { contentType: 'image/jpeg', byteSize: 3 }, CONTEXT)).url), 'PUT');

    await storage.write(grant, 'image/jpeg', Readable.from([Buffer.from('abc')]));

    expect(await storage.stat(KEY)).toEqual({ size: 3, contentType: 'image/jpeg' });
    expect(await readFile(join(dir, KEY), 'utf8')).toBe('abc');
    const file = await storage.read({ k: KEY, m: 'GET', exp: now + 1000 });
    expect(file).toMatchObject({ size: 3, contentType: 'image/jpeg' });
    file!.stream.destroy();
    await storage.delete(KEY);
    expect(await storage.stat(KEY)).toBeNull();
    await storage.delete(KEY);
  });

  it('refuses an upload larger than the grant, writing nothing', async () => {
    const grant = { k: KEY, m: 'PUT' as const, exp: now + 1000, ct: 'image/jpeg', n: 3 };

    await expect(storage.write(grant, 'image/jpeg', Readable.from([Buffer.from('ab'), Buffer.from('cd')]))).rejects.toThrow(UploadTooLargeError);
    expect(await storage.stat(KEY)).toBeNull();
  });

  it('only touches engine-shaped keys (no path traversal)', async () => {
    await expect(storage.stat('../../etc/passwd')).resolves.toBeNull();
    await expect(storage.delete('moments/../../x.jpg')).rejects.toThrow(InvalidFileTokenError);
  });
});
