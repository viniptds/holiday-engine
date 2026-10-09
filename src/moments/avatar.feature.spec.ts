import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import type { UserDto } from '../users/user.dto.js';
import { RateWindow } from '../app-common/rate-window.js';
import { AvatarUpload } from './avatar-upload.entity.js';
import { AVATAR_UPLOAD_LIMIT, AvatarService } from './avatar.service.js';
import type { PresignedUpload } from './storage/object-storage.js';
import { MemoryObjectStorage } from './testing/moments-testing.js';
import { bootMoments, EDITOR, OWNER } from './testing/harness.js';
import type { Harness } from './testing/harness.js';

const FILE = { contentType: 'image/jpeg', byteSize: 4096, width: 512, height: 512 };
const GOOGLE_PIC = 'https://lh3.googleusercontent.com/a/owner';
type Started = { uploadId: string; upload: PresignedUpload };

describe('Profile picture (feature)', () => {
  const storage = new MemoryObjectStorage();
  let h: Harness;
  let service: AvatarService;
  const logged: string[] = [];

  beforeAll(async () => {
    h = await bootMoments({ storage });
    service = h.moduleRef.get(AvatarService);
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    h.db.clear();
    h.seedUsers();
    await h.db.repository(User).update({ id: OWNER }, { googlePictureUrl: GOOGLE_PIC, avatarUrl: GOOGLE_PIC });
    storage.reset();
    Object.assign(service, { uploadsWindow: new RateWindow(AVATAR_UPLOAD_LIMIT.max, AVATAR_UPLOAD_LIMIT.windowMs, 'Too many profile picture uploads. Please wait a little.') });
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  const row = (id = OWNER) => h.db.all(User, { id })[0];

  /** Starts an upload, stores the object as the client would, and completes it. */
  async function upload(user = OWNER): Promise<{ key: string; user: UserDto }> {
    const started = await h.json<Started>('POST', '/me/avatar', user, FILE);
    expect(started.status).toBe(201);
    const key = h.db.all(AvatarUpload, { id: started.body.uploadId })[0].objectKey;
    storage.put(key, FILE.byteSize);
    const done = await h.json<UserDto>('POST', '/me/avatar/complete', user, { uploadId: started.body.uploadId });
    expect(done.status).toBe(200);
    return { key, user: done.body };
  }

  it('uploads to avatars/<userId>/ with the presigned flow and serves it as a signed URL, also to other members', async () => {
    const started = await h.json<Started>('POST', '/me/avatar', OWNER, FILE);
    expect(started.body.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    const key = h.db.all(AvatarUpload)[0].objectKey;
    expect(key).toMatch(new RegExp(`^avatars/${OWNER}/[0-9a-f-]{36}\\.jpg$`));
    storage.put(key, FILE.byteSize);

    const done = await h.json<UserDto>('POST', '/me/avatar/complete', OWNER, { uploadId: started.body.uploadId });

    expect(done.body).toMatchObject({ avatarSource: 'custom', avatarUrl: `https://bucket.test/${key}?signed=get`, hasGooglePicture: true });
    expect(row()).toMatchObject({ avatarSource: 'custom', avatarKey: key });
    expect(h.db.all(AvatarUpload)).toEqual([]);
    expect((await h.json<UserDto>('GET', '/me', OWNER)).body.avatarUrl).toBe(`https://bucket.test/${key}?signed=get`);
    const trip = h.seedTrip([[OWNER, 'owner'], [EDITOR, 'editor']]);
    const members = await h.json<{ members: { userId: string; avatarUrl: string | null }[] }>('GET', `/trips/${trip.id}/members`, EDITOR);
    expect(members.body.members.find((m) => m.userId === OWNER)?.avatarUrl).toBe(`https://bucket.test/${key}?signed=get`);
  });

  it('keeps only the latest picture: a replacement deletes the previous object', async () => {
    const first = await upload();
    const second = await upload();

    expect(storage.deleted).toEqual([first.key]);
    expect([...storage.objects.keys()]).toEqual([second.key]);
    expect(row().avatarKey).toBe(second.key);
  });

  it('checks the upload: missing → 409 UPLOAD_INCOMPLETE; wrong size → 409 UPLOAD_MISMATCH and deleted; an untyped JPEG is fixed', async () => {
    const started = await h.json<Started>('POST', '/me/avatar', OWNER, FILE);
    const key = h.db.all(AvatarUpload)[0].objectKey;
    expect((await h.json('POST', '/me/avatar/complete', OWNER, { uploadId: started.body.uploadId })).body).toMatchObject({ reason: 'UPLOAD_INCOMPLETE' });
    expect((await h.json('POST', '/me/avatar/complete', EDITOR, { uploadId: started.body.uploadId })).status).toBe(404);

    storage.put(key, 99);
    expect((await h.json('POST', '/me/avatar/complete', OWNER, { uploadId: started.body.uploadId })).body).toMatchObject({ reason: 'UPLOAD_MISMATCH' });
    expect(storage.deleted).toEqual([key]);
    expect(row().avatarSource).toBe('google');

    const again = await h.json<Started>('POST', '/me/avatar', OWNER, FILE);
    const againKey = h.db.all(AvatarUpload, { id: again.body.uploadId })[0].objectKey;
    storage.put(againKey, FILE.byteSize, null);
    expect((await h.json<UserDto>('POST', '/me/avatar/complete', OWNER, { uploadId: again.body.uploadId })).body.avatarSource).toBe('custom');
    expect(storage.objects.get(againKey)?.contentType).toBe('image/jpeg');
  });

  it.each([
    [{ ...FILE, byteSize: 5 * 1024 * 1024 + 1 }],
    [{ ...FILE, contentType: 'image/png' }],
    [{ ...FILE, width: 0 }],
  ])('validates %j', async (body) => {
    expect((await h.json('POST', '/me/avatar', OWNER, body)).status).toBe(400);
  });

  it('removes the picture (none, the object deleted), and Google sign-in never brings it back', async () => {
    const { key } = await upload();

    const removed = await h.json<UserDto>('DELETE', '/me/avatar', OWNER);

    expect(removed.body).toMatchObject({ avatarSource: 'none', avatarUrl: null });
    expect(storage.deleted).toEqual([key]);
    const users = h.moduleRef.get(UsersService);
    const signedIn = await users.findOrCreateFromGoogle({ sub: `google-${OWNER}`, email: '1111@example.com', name: 'X', picture: 'https://lh3.googleusercontent.com/a/new' });
    expect(signedIn).toMatchObject({ avatarSource: 'none', avatarUrl: null, googlePictureUrl: 'https://lh3.googleusercontent.com/a/new' });
    expect((await h.json<UserDto>('GET', '/me', OWNER)).body.avatarUrl).toBeNull();
  });

  it('keeps a custom picture on Google sign-in, and follows Google while the source is google', async () => {
    const users = h.moduleRef.get(UsersService);
    const { key } = await upload();
    await users.findOrCreateFromGoogle({ sub: `google-${OWNER}`, email: '1111@example.com', name: 'X', picture: 'https://lh3.googleusercontent.com/a/v2' });
    expect(row()).toMatchObject({ avatarSource: 'custom', avatarKey: key, googlePictureUrl: 'https://lh3.googleusercontent.com/a/v2' });

    await users.findOrCreateFromGoogle({ sub: `google-${EDITOR}`, email: '2222@example.com', name: 'X', picture: 'https://lh3.googleusercontent.com/a/editor' });
    expect(row(EDITOR)).toMatchObject({ avatarSource: 'google', avatarUrl: 'https://lh3.googleusercontent.com/a/editor' });
  });

  it('"Use Google photo" restores it and deletes the custom object; 409 without a Google picture', async () => {
    const { key } = await upload();

    const restored = await h.json<UserDto>('POST', '/me/avatar/google', OWNER);
    expect(restored.body).toMatchObject({ avatarSource: 'google', avatarUrl: GOOGLE_PIC });
    expect(storage.deleted).toEqual([key]);
    expect(row().avatarKey).toBeNull();

    const none = await h.json('POST', '/me/avatar/google', EDITOR);
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ reason: 'NO_GOOGLE_PICTURE' });
  });

  it('allows 10 uploads an hour per user', async () => {
    for (let i = 0; i < 10; i++) expect((await h.call('POST', '/me/avatar', OWNER, FILE)).status).toBe(201);
    expect((await h.call('POST', '/me/avatar', OWNER, FILE)).status).toBe(429);
    expect((await h.call('POST', '/me/avatar', EDITOR, FILE)).status).toBe(201);
  });

  it('logs a failed delete with the key and retries it in the cleanup; removes unfinished uploads after an hour', async () => {
    const first = await upload();
    storage.failDeletes = true;
    await upload();
    expect(logged.some((l) => l.includes(`deleting ${first.key} failed`))).toBe(true);
    expect(h.db.all(AvatarUpload, { status: 'orphan' }).map((u) => u.objectKey)).toEqual([first.key]);

    storage.failDeletes = false;
    const stale = await h.json<Started>('POST', '/me/avatar', OWNER, FILE);
    const staleKey = h.db.all(AvatarUpload, { id: stale.body.uploadId })[0].objectKey;
    storage.put(staleKey, 1);
    expect(await service.cleanup(new Date(Date.now() + 30 * 60_000))).toBe(1);
    expect(await service.cleanup(new Date(Date.now() + 61 * 60_000))).toBe(1);
    expect(h.db.all(AvatarUpload)).toEqual([]);
    expect(storage.deleted).toEqual(expect.arrayContaining([first.key, staleKey]));
  });

  it('account deletion removes the picture and unfinished uploads', async () => {
    const { key } = await upload();
    const pending = await h.json<Started>('POST', '/me/avatar', OWNER, FILE);
    const pendingKey = h.db.all(AvatarUpload, { id: pending.body.uploadId })[0].objectKey;

    await h.moduleRef.get(UserDeletionHooks).run(OWNER);

    expect(storage.deleted).toEqual(expect.arrayContaining([key, pendingKey]));
    expect(row()).toMatchObject({ avatarKey: null });
    expect(h.db.all(AvatarUpload)).toEqual([]);
  });
});

describe('Profile picture with the local driver', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'holidai-avatar-'));
    h = await bootMoments({ config: { STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: dir, ENGINE_PUBLIC_URL: 'https://api.holid.test' } });
  });

  afterAll(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('signs the avatar with the engine\'s /files URL, which serves it', async () => {
    h.db.clear();
    h.seedUsers();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    const started = await h.json<Started>('POST', '/me/avatar', OWNER, { ...FILE, byteSize: jpeg.length });
    expect((await fetch(started.body.upload.url, { method: 'PUT', headers: started.body.upload.headers, body: jpeg })).status).toBe(200);

    const done = await h.json<UserDto>('POST', '/me/avatar/complete', OWNER, { uploadId: started.body.uploadId });

    expect(done.body.avatarUrl).toMatch(/^https:\/\/api\.holid\.test\/app\/v1\/files\//);
    const local = done.body.avatarUrl!.replace('https://api.holid.test/app/v1', h.baseUrl);
    const res = await fetch(local);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(jpeg);
  });
});
