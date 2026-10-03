import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import type { AuthenticatedRequest } from './auth.guard.js';

/** The signed-in user set by `AuthGuard`. */
export function currentUserFrom(context: ExecutionContext): AuthUser {
  const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
  // Only reachable if a route forgot `@UseGuards(AuthGuard)`.
  if (!user) throw new AppError('UNAUTHENTICATED', 'Missing access token');
  return user;
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => currentUserFrom(context));
