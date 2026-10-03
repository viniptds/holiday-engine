import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { UsersService } from '../users/users.service.js';
import { isDevLoginAccount } from './dev-login.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export type AccessToken = { accessToken: string; accessTokenExpiresAt: string };

const invalidAccessToken = () => new AppError('UNAUTHENTICATED', 'Invalid or expired access token');

/** Issues and checks access tokens: HS256 JWTs, `sub` = user id, valid 15 minutes. */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  async issue(userId: string, now = new Date()): Promise<AccessToken> {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await this.jwt.signAsync({ sub: userId, iat, exp }, { algorithm: 'HS256' });
    return { accessToken, accessTokenExpiresAt: new Date(exp * 1000).toISOString() };
  }

  /** The user the token belongs to; throws `UNAUTHENTICATED` if the token is bad or expired, or the user is deleted. */
  async authenticate(token: string): Promise<AuthUser> {
    let sub: unknown;
    try {
      ({ sub } = await this.jwt.verifyAsync<{ sub?: unknown }>(token, { algorithms: ['HS256'] }));
    } catch {
      throw invalidAccessToken();
    }
    if (typeof sub !== 'string') throw invalidAccessToken();
    // Malformed ids would make Postgres throw on the uuid column.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sub)) throw invalidAccessToken();

    const user = await this.users.findActive(sub);
    if (!user) throw invalidAccessToken();
    return { id: user.id, email: user.email, devAccount: isDevLoginAccount(user.googleSub) };
  }
}
