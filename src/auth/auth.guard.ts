import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AccessTokenService } from './access-token.service.js';

// Minimal shape of the Express request (no @types/express in this project).
export type AuthenticatedRequest = { headers: Record<string, string | string[] | undefined>; user?: AuthUser };

/**
 * Requires `Authorization: Bearer <accessToken>` for a live user and sets `request.user` (read it with
 * `@CurrentUser()`). Use with `@UseFilters(AppExceptionFilter)` so failures become `401 UNAUTHENTICATED`.
 * Modules using it import `AuthModule`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly accessTokens: AccessTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
    if (!match) throw new AppError('UNAUTHENTICATED', 'Missing access token');

    request.user = await this.accessTokens.authenticate(match[1]);
    return true;
  }
}
