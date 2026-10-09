import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import type { UserDirectory, UserProfile } from '../app-common/auth-user.js';
import { User } from './user.entity.js';
import type { UpdateProfileDto } from './dto/update-profile.dto.js';

/** Verified claims of a Google ID token, as the users module needs them. */
export type GoogleIdentity = { sub: string; email: string; name: string | null; picture: string | null };

const DISPLAY_NAME_MAX = 100;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

function displayNameFrom(identity: GoogleIdentity): string {
  const name = identity.name?.replace(CONTROL_CHARS, ' ').trim().slice(0, DISPLAY_NAME_MAX).trim();
  return name || identity.email.split('@')[0].slice(0, DISPLAY_NAME_MAX) || 'Traveler';
}

const isUniqueViolation = (error: unknown) =>
  error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === '23505';

/** App users. Soft-deleted users are invisible to every method here. */
@Injectable()
export class UsersService implements UserDirectory {
  constructor(@InjectRepository(User) private readonly users: Repository<User>) {}

  /** The live user for this Google account, created on first sign-in. Email and avatar follow Google. */
  async findOrCreateFromGoogle(identity: GoogleIdentity): Promise<User> {
    const existing = await this.users.findOne({ where: { googleSub: identity.sub } });
    if (existing) return this.refreshFromGoogle(existing, identity);

    try {
      return await this.users.save(
        this.users.create({
          googleSub: identity.sub,
          email: identity.email,
          displayName: displayNameFrom(identity),
          avatarUrl: identity.picture,
          homeCity: null,
        }),
      );
    } catch (error) {
      // A concurrent first sign-in created the user first.
      if (!isUniqueViolation(error)) throw error;
      const created = await this.users.findOne({ where: { googleSub: identity.sub } });
      if (!created) throw error;
      return created;
    }
  }

  /** The live user, or null if unknown or deleted. */
  findActive(id: string): Promise<User | null> {
    return this.users.findOne({ where: { id } });
  }

  async get(id: string): Promise<User> {
    const user = await this.findActive(id);
    if (!user) throw new AppError('NOT_FOUND', 'User not found');
    return user;
  }

  async update(id: string, changes: UpdateProfileDto): Promise<User> {
    const user = await this.get(id);
    if (changes.displayName !== undefined) user.displayName = changes.displayName;
    if (changes.homeCity !== undefined) user.homeCity = changes.homeCity;
    return this.users.save(user);
  }

  /** Stores the user's IANA time zone (already validated). */
  async setLocale(id: string, locale: string): Promise<void> {
    await this.users.update({ id }, { locale });
  }

  async setTimezone(id: string, timezone: string): Promise<void> {
    await this.users.update({ id }, { timezone });
  }

  async softDelete(id: string): Promise<void> {
    await this.users.softDelete({ id });
  }

  /** `UserDirectory`: profiles of live users; unknown and deleted ids are left out of the map. */
  async getProfiles(ids: string[]): Promise<Map<string, UserProfile>> {
    const unique = [...new Set(ids)];
    const profiles = new Map<string, UserProfile>();
    if (unique.length === 0) return profiles;
    const users = await this.users.find({ where: { id: In(unique) } });
    for (const user of users) {
      profiles.set(user.id, { id: user.id, displayName: user.displayName, avatarUrl: user.avatarUrl ?? null });
    }
    return profiles;
  }

  private async refreshFromGoogle(user: User, identity: GoogleIdentity): Promise<User> {
    if (user.email === identity.email && user.avatarUrl === identity.picture) return user;
    user.email = identity.email;
    user.avatarUrl = identity.picture;
    return this.users.save(user);
  }
}
