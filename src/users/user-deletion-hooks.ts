import { Injectable } from '@nestjs/common';

export type UserDeletionHook = (userId: string) => Promise<void>;

/**
 * Work other features must do when a user deletes their account (e.g. leaving or deleting trips).
 * Features register a hook on startup (`onModuleInit`); `DELETE /me` runs them all, in registration
 * order, before the user is soft-deleted. A failing hook aborts the deletion, so it can be retried.
 */
@Injectable()
export class UserDeletionHooks {
  private readonly hooks: UserDeletionHook[] = [];

  register(hook: UserDeletionHook): void {
    this.hooks.push(hook);
  }

  async run(userId: string): Promise<void> {
    for (const hook of this.hooks) await hook(userId);
  }
}
