import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';

export const DEV_USER_ID_HEADER = 'x-dev-user-id';
export const DEV_USER_EMAIL_HEADER = 'x-dev-user-email';

type DevRequest = { headers: Record<string, string | string[] | undefined>; user?: AuthUser };

const header = (request: DevRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return typeof value === 'string' ? value.trim() : undefined;
};

/**
 * TEMPORARY stand-in for the real AuthGuard (auth branch, gate G1): trusts the
 * `x-dev-user-id` (UUID v4) and `x-dev-user-email` headers and attaches them as `request.user`.
 * Refuses everything when NODE_ENV is `production`, so it can't ship as an open door.
 */
@Injectable()
export class DevAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    const request = context.switchToHttp().getRequest<DevRequest>();
    const id = header(request, DEV_USER_ID_HEADER);
    const email = header(request, DEV_USER_EMAIL_HEADER);
    if (!id || !isUUID(id, '4') || !email || !isEmail(email)) {
      throw new AppError('UNAUTHENTICATED', 'Authentication required');
    }
    request.user = { id: id.toLowerCase(), email };
    return true;
  }
}
