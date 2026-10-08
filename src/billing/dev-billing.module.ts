import { Body, Controller, HttpCode, HttpStatus, Logger, Module, OnModuleInit, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { isDevLoginEnabled } from '../auth/dev-login.js';
import { BillingModule } from './billing.module.js';
import { BillingService } from './billing.service.js';
import type { PlanDto } from './billing.types.js';

/** `POST /subscription/dev-grant` body. */
export class DevGrantDto {
  @IsIn(['plus', 'free'])
  tier: 'plus' | 'free';

  @IsOptional()
  @Max(3650)
  @Min(1)
  @IsInt()
  expiresInDays?: number;
}

/** DEV ONLY: lets testers (Expo Go, no real purchases) flip their own plan. */
@Controller(`${APP_PREFIX}/subscription`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class DevBillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('dev-grant')
  @HttpCode(HttpStatus.OK)
  async grant(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: DevGrantDto): Promise<{ plan: PlanDto }> {
    return { plan: await this.billing.devGrant(user, body.tier, body.expiresInDays) };
  }
}

@Module({ imports: [AuthModule, BillingModule], controllers: [DevBillingController] })
export class DevBillingModule implements OnModuleInit {
  onModuleInit() {
    new Logger(DevBillingModule.name).warn('DEV_LOGIN_ENABLED: POST /app/v1/subscription/dev-grant lets any user set their own plan.');
  }
}

/** The dev-grant route exists only under the dev-login rules (DEV_LOGIN_ENABLED, NODE_ENV development/test). */
export const devBillingModule = () => ConditionalModule.registerWhen(DevBillingModule, isDevLoginEnabled, { debug: false });
