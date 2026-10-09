import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from '../auth/auth.module.js';
import { MeExtensions } from '../users/me-extensions.js';
import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { BILLING_CONFIG, billingConfigFrom } from './billing.config.js';
import type { BillingConfig } from './billing.config.js';
import { BillingEvent } from './billing-event.entity.js';
import { UserEntitlement } from './user-entitlement.entity.js';
import { BILLING_PROVIDER, MockBillingProvider, RevenueCatProvider } from './revenuecat.js';
import { BillingService } from './billing.service.js';
import { AiQuotaService } from './ai-quota.service.js';
import { BillingWebhookController, SubscriptionController } from './billing.controller.js';

/**
 * Holid.ai Plus: entitlements, the RevenueCat webhook and sync, the free AI quota, and the `/me`
 * plan fields. Startup fails on bad billing settings (`readBillingConfig`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserEntitlement, BillingEvent, AiConversation, AiMessage]), AuthModule],
  controllers: [BillingWebhookController, SubscriptionController],
  providers: [
    { provide: BILLING_CONFIG, inject: [ConfigService], useFactory: billingConfigFrom },
    {
      provide: BILLING_PROVIDER,
      inject: [BILLING_CONFIG],
      useFactory: (config: BillingConfig) =>
        config.provider === 'revenuecat' ? new RevenueCatProvider(config.secretApiKey) : new MockBillingProvider(),
    },
    BillingService,
    AiQuotaService,
  ],
  exports: [BillingService, AiQuotaService],
})
export class BillingModule implements OnModuleInit {
  constructor(
    private readonly me: MeExtensions,
    private readonly billing: BillingService,
    private readonly quota: AiQuotaService,
  ) {}

  onModuleInit() {
    this.me.register(async ({ user, timeZone, now }) => {
      const plan = await this.billing.plan(user.id, now);
      const plus = plan.tier === 'plus';
      return {
        plan,
        aiQuota: await this.quota.status(user.id, plus, timeZone, now),
        limits: { tripPlaces: this.billing.placesLimit(plus), tripMoments: this.billing.momentsLimit(plus) },
        planLimits: this.billing.planLimits(),
      };
    });
  }
}
