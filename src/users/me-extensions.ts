import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../app-common/auth-user.js';

/** Context for the extra `/me` fields: the user and the request's time zone. */
export type MeContext = { user: AuthUser; timeZone: string; now: Date };
export type MeExtension = (context: MeContext) => Promise<Record<string, unknown>>;

/**
 * Fields other features add to `/me` (billing: `plan`, `aiQuota`, `limits`), registered on startup
 * so the users and auth modules don't depend on them. Later registrations win on a name clash.
 */
@Injectable()
export class MeExtensions {
  private readonly extensions: MeExtension[] = [];

  register(extension: MeExtension): void {
    this.extensions.push(extension);
  }

  async fields(context: MeContext): Promise<Record<string, unknown>> {
    const parts = await Promise.all(this.extensions.map((extension) => extension(context)));
    return Object.assign({}, ...parts);
  }
}
