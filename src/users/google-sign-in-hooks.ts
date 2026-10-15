import { Injectable, Logger } from '@nestjs/common';

export type GoogleSignInHook = (user: { id: string; email: string }) => Promise<void>;

/**
 * Best-effort work other features do after a Google sign-in (e.g. converting a web lead). Features
 * register a hook on startup; `AuthService` runs them all after the session's user exists. A failing
 * hook is logged (error name and user id only) and never fails the sign-in.
 */
@Injectable()
export class GoogleSignInHooks {
  private readonly logger = new Logger(GoogleSignInHooks.name);
  private readonly hooks: GoogleSignInHook[] = [];

  register(hook: GoogleSignInHook): void {
    this.hooks.push(hook);
  }

  async run(user: { id: string; email: string }): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(user);
      } catch (error) {
        this.logger.warn(`Sign-in hook failed for user ${user.id}: ${error instanceof Error ? error.name : 'unknown error'}`);
      }
    }
  }
}
