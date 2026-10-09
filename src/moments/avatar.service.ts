import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { LessThan, Repository } from 'typeorm';
import { AppError, conflict } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { RateWindow } from '../app-common/rate-window.js';
import { User } from '../users/user.entity.js';
import { UsersService } from '../users/users.service.js';
import { toUserDto } from '../users/user.dto.js';
import type { UserDto } from '../users/user.dto.js';
import { AvatarUpload } from './avatar-upload.entity.js';
import { OBJECT_STORAGE, avatarObjectKey } from './storage/object-storage.js';
import type { ObjectStorage, PresignedUpload, StorageRequestContext } from './storage/object-storage.js';

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const AVATAR_UPLOAD_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 };
const PENDING_TTL_MS = 60 * 60 * 1000;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const errorName = (error: unknown) => {
  const e = error as { name?: string; message?: string };
  return [e?.name, e?.message].filter(Boolean).join(': ').slice(0, 300) || 'unknown error';
};

/**
 * Profile pictures (docs/app-profile-offline-spec.md §1): uploaded with the moments' presigned
 * flow into `avatars/<userId>/`, only the latest kept. A custom or removed picture is never
 * overridden by Google; "Use Google photo" restores it.
 */
@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);
  private readonly uploadsWindow = new RateWindow(AVATAR_UPLOAD_LIMIT.max, AVATAR_UPLOAD_LIMIT.windowMs, 'Too many profile picture uploads. Please wait a little.');

  constructor(
    @InjectRepository(AvatarUpload) private readonly uploads: Repository<AvatarUpload>,
    @InjectRepository(User) private readonly userRows: Repository<User>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    private readonly users: UsersService,
  ) {}

  /** `POST /me/avatar`: where to PUT the JPEG (signed content type, 15 min). 10 an hour. */
  async start(user: AuthUser, file: { contentType: string; byteSize: number }, context: StorageRequestContext): Promise<{ uploadId: string; upload: PresignedUpload }> {
    this.uploadsWindow.take(user.id);
    const id = randomUUID();
    const objectKey = avatarObjectKey(user.id, id);
    await this.uploads.insert({ id, userId: user.id, objectKey, byteSize: file.byteSize, status: 'pending' });
    return { uploadId: id, upload: await this.storage.presignUpload(objectKey, { contentType: file.contentType, byteSize: file.byteSize }, context) };
  }

  /**
   * `POST /me/avatar/complete`: the upload must exist with the declared size and a JPEG type (an
   * untyped JPEG is accepted and fixed, as for moments). The picture becomes `custom` and the
   * previous custom object is deleted.
   */
  async complete(user: AuthUser, uploadId: string): Promise<UserDto> {
    if (!isUUID(uploadId, '4')) throw new AppError('NOT_FOUND', 'Upload not found');
    const upload = await this.uploads.findOne({ where: { id: uploadId.toLowerCase(), userId: user.id, status: 'pending' } });
    if (!upload) throw new AppError('NOT_FOUND', 'Upload not found');
    const object = await this.storage.stat(upload.objectKey);
    if (!object) throw conflict('UPLOAD_INCOMPLETE', 'The picture has not been uploaded yet');
    const type = object.contentType?.split(';')[0].trim().toLowerCase() || null;
    let accepted = object.size === upload.byteSize && type === 'image/jpeg';
    if (!accepted && object.size === upload.byteSize && type === null) accepted = await this.repairJpeg(upload.objectKey);
    if (!accepted) {
      await this.uploads.delete({ id: upload.id });
      await this.deleteObject(user.id, upload.objectKey);
      throw conflict('UPLOAD_MISMATCH', 'The uploaded picture does not match the declared size or type; start again');
    }
    const current = await this.users.get(user.id);
    await this.userRows.update({ id: user.id }, { avatarSource: 'custom', avatarKey: upload.objectKey, avatarUrl: null });
    await this.uploads.delete({ id: upload.id });
    if (current.avatarKey && current.avatarKey !== upload.objectKey) await this.deleteObject(user.id, current.avatarKey);
    this.logger.log(`User ${user.id} set a custom profile picture`);
    return this.present(user.id);
  }

  /** `DELETE /me/avatar`: back to the initial; Google won't bring the picture back. */
  async remove(user: AuthUser): Promise<UserDto> {
    const current = await this.users.get(user.id);
    await this.userRows.update({ id: user.id }, { avatarSource: 'none', avatarKey: null, avatarUrl: null });
    if (current.avatarKey) await this.deleteObject(user.id, current.avatarKey);
    return this.present(user.id);
  }

  /** `POST /me/avatar/google`: Google's picture again (409 NO_GOOGLE_PICTURE without one). */
  async useGoogle(user: AuthUser): Promise<UserDto> {
    const current = await this.users.get(user.id);
    if (!current.googlePictureUrl) throw conflict('NO_GOOGLE_PICTURE', 'There is no Google picture to use');
    await this.userRows.update({ id: user.id }, { avatarSource: 'google', avatarKey: null, avatarUrl: current.googlePictureUrl });
    if (current.avatarKey) await this.deleteObject(user.id, current.avatarKey);
    return this.present(user.id);
  }

  /** Account deletion: the picture and any unfinished uploads go. */
  async handleUserDeleted(userId: string): Promise<void> {
    const user = await this.users.findActive(userId);
    if (user?.avatarKey) {
      await this.userRows.update({ id: userId }, { avatarKey: null, avatarSource: 'none', avatarUrl: null });
      await this.deleteObject(userId, user.avatarKey, false);
    }
    for (const upload of await this.uploads.find({ where: { userId } })) {
      await this.deleteObject(userId, upload.objectKey, false);
      await this.uploads.delete({ id: upload.id });
    }
  }

  /** Every 10 minutes: unfinished uploads older than an hour, and objects whose delete failed. */
  @Interval('avatar-uploads-cleanup', 10 * 60 * 1000)
  async cleanup(now = new Date()): Promise<number> {
    let removed = 0;
    try {
      const due = [
        ...(await this.uploads.find({ where: { status: 'pending', createdAt: LessThan(new Date(now.getTime() - PENDING_TTL_MS)) }, take: 200 })),
        ...(await this.uploads.find({ where: { status: 'orphan' }, take: 200 })),
      ];
      for (const upload of due) {
        try {
          await this.storage.delete(upload.objectKey);
          await this.uploads.delete({ id: upload.id });
          removed++;
        } catch (error) {
          this.logger.warn(`Avatar cleanup: deleting ${upload.objectKey} failed: ${errorName(error)}`);
        }
      }
    } catch (error) {
      this.logger.error(`Avatar cleanup failed: ${errorName(error)}`);
    }
    return removed;
  }

  private async present(userId: string): Promise<UserDto> {
    const row = await this.users.get(userId);
    return toUserDto(row, await this.users.avatarUrlOf(row));
  }

  private async repairJpeg(key: string): Promise<boolean> {
    try {
      const start = await this.storage.readStart(key, JPEG_MAGIC.length);
      if (!start || !start.equals(JPEG_MAGIC)) return false;
      await this.storage.setContentType(key, 'image/jpeg');
      return true;
    } catch (error) {
      this.logger.warn(`Avatar: checking an untyped upload failed (key ${key}): ${errorName(error)}`);
      return false;
    }
  }

  /** Deletes an object; a failure is logged at warn with the key and (optionally) queued for the cleanup to retry. */
  private async deleteObject(userId: string, key: string, retry = true): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (error) {
      this.logger.warn(`Avatar: deleting ${key} failed: ${errorName(error)}`);
      if (retry) await this.uploads.insert({ id: randomUUID(), userId, objectKey: key, byteSize: 0, status: 'orphan' });
    }
  }
}
