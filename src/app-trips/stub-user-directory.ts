import { Injectable } from '@nestjs/common';
import type { UserDirectory, UserProfile } from '../app-common/auth-user.js';

/**
 * TEMPORARY `UserDirectory` until the users module lands (gate G1): every id resolves to
 * "Traveler <first 4 chars of id>" with no avatar.
 */
@Injectable()
export class StubUserDirectory implements UserDirectory {
  async getProfiles(ids: string[]): Promise<Map<string, UserProfile>> {
    return new Map(ids.map((id) => [id, { id, displayName: `Traveler ${id.slice(0, 4)}`, avatarUrl: null }]));
  }
}
