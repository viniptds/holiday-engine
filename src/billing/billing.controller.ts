import { Body, Controller, Headers, HttpCode, HttpStatus, Logger, Post, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppError } from '../app-common/app-error.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { BillingService } from './billing.service.js';
import type { PlanDto } from './billing.types.js';

/**
 * `POST /app/v1/billing/revenuecat-webhook`: RevenueCat calls it with the shared Authorization
 * value. No user session. 200 for anything handled, ignored, duplicate or test; 401 on bad auth.
 */
@Controller(`${APP_PREFIX}/billing`)
@UseFilters(AppExceptionFilter)
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(private readonly billing: BillingService) {}

  @Post('revenuecat-webhook')
  @HttpCode(HttpStatus.OK)
  async webhook(@Headers('authorization') authorization: string | undefined, @Body() body: unknown): Promise<{ result: string }> {
    if (!this.billing.webhookAuthorized(authorization)) {
      // Never the header value.
      this.logger.warn('RevenueCat webhook refused: bad or missing Authorization');
      throw new AppError('UNAUTHENTICATED', 'Invalid webhook authorization');
    }
    return { result: await this.billing.handleWebhook(body) };
  }
}

/** `POST /app/v1/subscription/sync`: the caller's plan, re-read from RevenueCat. */
@Controller(`${APP_PREFIX}/subscription`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class SubscriptionController {
  constructor(private readonly billing: BillingService) {}

  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async sync(@CurrentUser() user: AuthUser): Promise<{ plan: PlanDto }> {
    return { plan: await this.billing.sync(user) };
  }
}
