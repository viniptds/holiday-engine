import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Moment } from './moment.entity.js';
import type { CreatedMomentDto, MomentDto } from './moments.types.js';
import { bootMoments, OWNER } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

describe('Local storage end to end: /app/v1/files/:token (feature)', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holidai-files-'));
    h = await bootMoments({ config: { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: dir } });
  });

  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    h.db.clear();
    h.seedUsers();
  });

  async function create(byteSize = JPEG.length) {
    const created = await h.json<CreatedMomentDto>('POST', '/moments', OWNER, {
      contentType: 'image/jpeg',
      byteSize,
      width: 2,
      height: 2,
      takenAt: '2026-10-08T10:00:00Z',
    });
    expect(created.status).toBe(201);
    return created.body;
  }

  it('uploads to the signed URL (no bearer token), completes, and serves the photo at a signed GET URL', async () => {
    const { moment, upload } = await create();
    expect(upload.url.startsWith(`${h.baseUrl}/files/`)).toBe(true);

    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: JPEG });
    expect(put.status).toBe(200);
    const done = await h.json<MomentDto>('POST', `/moments/${moment.id}/complete`, OWNER);
    expect(done.status).toBe(200);
    expect(done.body.url).toMatch(new RegExp(`^${h.baseUrl}/files/`));

    const get = await fetch(done.body.url!);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await get.arrayBuffer())).toEqual(JPEG);
  });

  it('refuses a GET with the PUT URL, a tampered token, the wrong type and an oversized body', async () => {
    const { moment, upload } = await create();

    expect((await fetch(upload.url)).status).toBe(403);
    expect((await fetch(`${upload.url}x`, { method: 'PUT', headers: upload.headers, body: JPEG })).status).toBe(403);
    expect((await fetch(upload.url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: JPEG })).status).toBe(400);
    expect((await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: Buffer.concat([JPEG, JPEG]) })).status).toBe(413);
    // Nothing usable was stored: completing still waits for the upload.
    expect((await h.json('POST', `/moments/${moment.id}/complete`, OWNER)).body).toMatchObject({ reason: 'UPLOAD_INCOMPLETE' });
  });

  it('completes only an upload of the declared size', async () => {
    const { moment, upload } = await create(JPEG.length + 5);

    expect((await fetch(upload.url, { method: 'PUT', headers: upload.headers, body: JPEG })).status).toBe(200);

    expect((await h.json('POST', `/moments/${moment.id}/complete`, OWNER)).body).toMatchObject({ reason: 'UPLOAD_MISMATCH' });
    expect(h.db.all(Moment)).toEqual([]);
  });
});
