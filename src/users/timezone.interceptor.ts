import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthUser } from '../app-common/auth-user.js';
import { isValidTimeZone, TIMEZONE_HEADER } from '../app-common/timezone.js';
import { UsersService } from './users.service.js';

type Request = { headers: Record<string, string | string[] | undefined>; user?: AuthUser };

/**
 * Stores the signed-in user's `X-Timezone` when it's a valid IANA zone that differs from the one
 * on file (docs/app-subscriptions-spec.md, Time zone). Invalid or missing headers change nothing.
 * Runs after the guards, so only on authenticated requests; a failed write never fails the request.
 */
@Injectable()
export class TimezoneInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TimezoneInterceptor.name);

  constructor(private readonly users: UsersService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() === 'http') {
      const request = context.switchToHttp().getRequest<Request>();
      const header = request.headers?.[TIMEZONE_HEADER];
      const zone = (Array.isArray(header) ? header[0] : header)?.trim();
      const user = request.user;
      if (user && isValidTimeZone(zone) && zone !== user.timezone) {
        try {
          await this.users.setTimezone(user.id, zone);
          user.timezone = zone;
        } catch (error) {
          this.logger.warn(`Couldn't store the time zone for user ${user.id}: ${(error as Error).name}`);
        }
      }
    }
    return next.handle();
  }
}
