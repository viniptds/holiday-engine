import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthUser } from '../app-common/auth-user.js';

/** The `AuthUser` the auth guard attached to the request. Use only behind the guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthUser => context.switchToHttp().getRequest<{ user: AuthUser }>().user,
);
