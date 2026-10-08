import { Inject, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { AppTripsModule } from '../app-trips/app-trips.module.js';
import { WizardModule } from '../wizard/wizard.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { UserDeletionHooks } from '../users/user-deletion-hooks.js';
import { AI_CONFIG, aiConfigFrom } from './ai.config.js';
import type { AiConfig } from './ai.config.js';
import { AiService } from './ai.service.js';
import { AiConversationsController, TripAiConversationsController, TripItineraryController, TripPlacesController } from './ai.controller.js';
import { ItineraryService } from './itinerary.service.js';
import { TripScheduleHooks } from '../app-trips/trip-schedule-hooks.js';
import { AiConversation } from './entities/ai-conversation.entity.js';
import { AiMessage } from './entities/ai-message.entity.js';
import { TripPlace } from './entities/trip-place.entity.js';
import { LLM_PROVIDER } from './llm/llm-provider.js';
import type { LlmProvider } from './llm/llm-provider.js';
import { AnthropicProvider } from './llm/anthropic.provider.js';
import { OpenAiProvider } from './llm/openai.provider.js';
import { MockLlmProvider } from './llm/mock-llm.provider.js';
import { PLACES_PROVIDER } from './places/places-provider.js';
import type { PlacesDirectory } from './places/places-provider.js';
import { GooglePlacesProvider } from './places/google-places.provider.js';
import { MockPlacesProvider } from './places/mock-places.provider.js';
import { PlacesVerifier } from './places/places-verifier.js';

/** The LLM selected by `AI_PROVIDER` / `AI_MODEL`. */
export function createLlmProvider(config: AiConfig): LlmProvider {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicProvider({
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: config.maxTokens,
        effort: config.effort,
        fallbacks: config.fallbacks,
        timeoutMs: config.timeoutMs,
        workspaceId: config.anthropicWorkspaceId,
      });
    case 'openai':
      return new OpenAiProvider({
        apiKey: config.apiKey,
        model: config.model,
        maxTokens: config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
    case 'mock':
      return new MockLlmProvider();
  }
}

/** The places provider selected by `PLACES_PROVIDER`. */
export function createPlacesProvider(config: AiConfig): PlacesDirectory {
  return config.placesProvider === 'google' ? new GooglePlacesProvider(config.placesApiKey) : new MockPlacesProvider();
}

/**
 * AI trip planning: conversations, drafts checked against Google Places, and trip places. Startup
 * fails on bad AI settings (`readAiConfig`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AiConversation, AiMessage, TripPlace, Trip, TripMember]), AuthModule, AppTripsModule, WizardModule, BillingModule],
  controllers: [AiConversationsController, TripAiConversationsController, TripPlacesController, TripItineraryController],
  providers: [
    { provide: AI_CONFIG, inject: [ConfigService], useFactory: aiConfigFrom },
    { provide: LLM_PROVIDER, inject: [AI_CONFIG], useFactory: createLlmProvider },
    { provide: PLACES_PROVIDER, inject: [AI_CONFIG], useFactory: createPlacesProvider },
    PlacesVerifier,
    ItineraryService,
    AiService,
  ],
  exports: [AiService, AI_CONFIG, PLACES_PROVIDER, ItineraryService],
})
export class AiModule implements OnModuleInit {
  private readonly logger = new Logger(AiModule.name);

  constructor(
    private readonly deletionHooks: UserDeletionHooks,
    private readonly ai: AiService,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    private readonly scheduleHooks: TripScheduleHooks,
    private readonly itinerary: ItineraryService,
  ) {}

  onModuleInit() {
    this.logger.log(`AI provider ${this.config.provider} (${this.config.model}), places ${this.config.placesProvider}`);
    // `DELETE /me`: the user's conversations are deleted; places they added stay with the trips.
    this.deletionHooks.register(async (userId) => {
      await this.ai.handleUserDeleted(userId);
    });
    // A date change moves places off days the trip no longer has (docs/app-itinerary-spec.md).
    this.scheduleHooks.register((manager, trip) => this.itinerary.onDatesChanged(manager, trip));
  }
}
