import { Injectable } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import { UsersService } from '../users/users.service.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { GoogleSignInHooks } from '../users/google-sign-in-hooks.js';
import { toUserDto } from '../users/user.dto.js';
import type { UserDto } from '../users/user.dto.js';
import type { User } from '../users/user.entity.js';
import { GoogleTokenVerifier } from './google-token-verifier.js';
import { AccessTokenService } from './access-token.service.js';
import { RefreshTokenService } from './refresh-token.service.js';

/** Contract `AuthSession`. */
export type AuthSession = { accessToken: string; accessTokenExpiresAt: string; refreshToken: string; user: UserDto };

@Injectable()
export class AuthService {
  constructor(
    private readonly google: GoogleTokenVerifier,
    private readonly users: UsersService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly deletionHooks: UserDeletionHooks,
    private readonly signInHooks: GoogleSignInHooks,
  ) {}

  async signInWithGoogle(idToken: string): Promise<AuthSession> {
    const identity = await this.google.verify(idToken);
    const user = await this.users.findOrCreateFromGoogle(identity);
    // Best effort (e.g. converting a web lead): never blocks or fails the sign-in.
    await this.signInHooks.run({ id: user.id, email: user.email });
    const { token } = await this.refreshTokens.issue(user.id);
    return this.session(user, token);
  }

  /**
   * DEV ONLY (`POST /auth/dev`): signs in as the user with googleSub `dev:<email>`, created on first
   * use (display name defaults to the email's local part). Same sessions as Google sign-in.
   */
  async signInWithDevLogin(email: string, displayName?: string): Promise<AuthSession> {
    const normalized = email.trim().toLowerCase();
    const user = await this.users.findOrCreateFromGoogle({
      sub: `dev:${normalized}`,
      email: normalized,
      name: displayName ?? null,
      picture: null,
    });
    const { token } = await this.refreshTokens.issue(user.id);
    return this.session(user, token);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const { userId, token } = await this.refreshTokens.rotate(refreshToken);
    const user = await this.users.findActive(userId);
    if (!user) {
      await this.refreshTokens.revokeAllForUser(userId);
      throw new AppError('UNAUTHENTICATED', 'Invalid refresh token');
    }
    return this.session(user, token);
  }

  logout(refreshToken: string): Promise<void> {
    return this.refreshTokens.revoke(refreshToken);
  }

  /**
   * `DELETE /me`: runs the registered deletion hooks (trips and memberships), then revokes every
   * refresh token and soft-deletes the user. A failing hook leaves the account intact.
   */
  async deleteAccount(userId: string): Promise<void> {
    await this.deletionHooks.run(userId);
    await this.refreshTokens.revokeAllForUser(userId);
    await this.users.softDelete(userId);
  }

  private async session(user: User, refreshToken: string): Promise<AuthSession> {
    const access = await this.accessTokens.issue(user.id);
    return { ...access, refreshToken, user: toUserDto(user, await this.users.avatarUrlOf(user)) };
  }
}
