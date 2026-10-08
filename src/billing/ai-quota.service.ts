import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual } from 'typeorm';
import type { EntityManager, Repository } from 'typeorm';
import { paymentRequired } from '../app-common/app-error.js';
import { localDayBounds } from '../app-common/timezone.js';
import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { BillingService } from './billing.service.js';
import type { AiQuotaDto } from './billing.types.js';

/**
 * The free AI quota (docs/app-subscriptions-spec.md): FREE_AI_MESSAGES_PER_DAY user messages per
 * local day (midnight to midnight in the user's zone). Counts user-message rows, not attempts, so
 * retrying a failed reply doesn't use quota. Plus has no daily quota (fair use still applies).
 */
@Injectable()
export class AiQuotaService {
  constructor(
    @InjectRepository(AiConversation) private readonly conversations: Repository<AiConversation>,
    private readonly billing: BillingService,
  ) {}

  /**
   * Inside the per-user advisory-lock transaction that then stores the message: a free user at the
   * limit → 402 PAYMENT_REQUIRED / AI_QUOTA_EXCEEDED with `resetsAt` (nothing stored).
   */
  async enforce(manager: EntityManager, userId: string, timeZone: string, now = new Date()): Promise<void> {
    if (await this.billing.isPlus(userId, now, manager)) return;
    const { start, end } = localDayBounds(timeZone, now);
    const limit = this.billing.freeAiMessagesPerDay;
    if ((await this.used(manager, userId, start, end)) >= limit) {
      throw paymentRequired('AI_QUOTA_EXCEEDED', `The free plan includes ${limit} AI messages a day`, { resetsAt: end.toISOString() });
    }
  }

  /** `/me` → `aiQuota`. */
  async status(userId: string, plus: boolean, timeZone: string, now = new Date()): Promise<AiQuotaDto> {
    const { start, end } = localDayBounds(timeZone, now);
    const used = await this.conversations.manager.transaction((manager) => this.used(manager, userId, start, end));
    if (plus) return { limit: null, used, remaining: null, resetsAt: end.toISOString() };
    const limit = this.billing.freeAiMessagesPerDay;
    return { limit, used, remaining: Math.max(0, limit - used), resetsAt: end.toISOString() };
  }

  /** The user's messages sent in [start, end). */
  private async used(manager: EntityManager, userId: string, start: Date, end: Date): Promise<number> {
    // A user message bumps its conversation's updatedAt, so older conversations can't hold any.
    const recent = await manager.find(AiConversation, { where: { userId, updatedAt: MoreThanOrEqual(start) } });
    if (recent.length === 0) return 0;
    const sent = await manager.find(AiMessage, {
      where: { conversationId: In(recent.map((c) => c.id)), role: 'user', createdAt: MoreThanOrEqual(start) },
    });
    return sent.filter((m) => new Date(m.createdAt).getTime() < end.getTime()).length;
  }
}
