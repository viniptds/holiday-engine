import { createHash, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import type { EntityManager, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { UsersService } from '../users/users.service.js';
import { MAX_TRIP_PLACES } from '../ai/ai.types.js';
import { BILLING_CONFIG } from './billing.config.js';
import type { BillingConfig } from './billing.config.js';
import { BillingEvent } from './billing-event.entity.js';
import { UserEntitlement } from './user-entitlement.entity.js';
import { BILLING_PROVIDER } from './revenuecat.js';
import type { BillingProvider, RevenueCatSubscriber } from './revenuecat.js';
import { concernsEntitlement, HANDLED_EVENTS, isPlusState, stateAfterEvent, stateFromSubscriber } from './entitlement-state.js';
import type { EntitlementState, RevenueCatEvent } from './entitlement-state.js';
import { SYNC_RATE_LIMIT } from './billing.types.js';
import type { PlanDto, PlanLimitsDto } from './billing.types.js';

/** Transaction-scoped advisory lock (as the AI and invite limits use). */
const ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';
const DAY_MS = 86_400_000;
const MAX_TRACKED_SYNCERS = 10_000;

const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown })?.code === '23505' || (error as { driverError?: { code?: unknown } })?.driverError?.code === '23505';
const digest = (value: string) => createHash('sha256').update(value).digest();

export type WebhookOutcome = 'applied' | 'duplicate' | 'ignored' | 'test';

/**
 * Holid.ai Plus entitlements (docs/app-subscriptions-spec.md). `user_entitlements` is the source of
 * truth for "is Plus"; RevenueCat (webhook as trigger, REST as truth) or dev grants change it.
 * Every write runs under a per-user advisory lock. Never logs secrets, the webhook Authorization
 * header or emails.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  /** userId → times of recent syncs (per process). */
  private readonly syncs = new Map<string, number[]>();

  constructor(
    @InjectRepository(UserEntitlement) private readonly entitlements: Repository<UserEntitlement>,
    @InjectRepository(BillingEvent) private readonly events: Repository<BillingEvent>,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    @Inject(BILLING_PROVIDER) private readonly provider: BillingProvider,
    private readonly users: UsersService,
  ) {}

  /** The user's `plus` entitlement row, if any (inside `manager`'s transaction when given). */
  entitlement(userId: string, manager?: EntityManager): Promise<UserEntitlement | null> {
    const where = { userId, entitlement: this.config.entitlementId };
    return manager ? manager.findOne(UserEntitlement, { where }) : this.entitlements.findOne({ where });
  }

  /** True when the `plus` row is active or in grace, with no expiry or one after `now`. */
  async isPlus(userId: string, now = new Date(), manager?: EntityManager): Promise<boolean> {
    return isPlusState(await this.entitlement(userId, manager), now);
  }

  /** Places a trip may hold for its owner's plan: 200 with Plus, else FREE_TRIP_PLACES_LIMIT. */
  placesLimit(plus: boolean): number {
    return plus ? MAX_TRIP_PLACES : this.config.freeTripPlacesLimit;
  }

  /** The place limit of a trip, by its OWNER's plan (editors follow the owner). */
  async tripPlacesLimit(ownerUserId: string | null, manager?: EntityManager, now = new Date()): Promise<number> {
    return this.placesLimit(ownerUserId ? await this.isPlus(ownerUserId, now, manager) : false);
  }

  /** Photos a trip may hold for its owner's plan. */
  momentsLimit(plus: boolean): number {
    return plus ? this.config.plusMomentsPerTrip : this.config.freeMomentsPerTrip;
  }

  /** `/me` → `planLimits`: what each plan gets, from the configured limits. */
  planLimits(): PlanLimitsDto {
    return {
      free: { aiMessagesPerDay: this.config.freeAiMessagesPerDay, tripPlaces: this.placesLimit(false), tripMoments: this.momentsLimit(false) },
      plus: { tripPlaces: this.placesLimit(true), tripMoments: this.momentsLimit(true) },
    };
  }

  get freeAiMessagesPerDay(): number {
    return this.config.freeAiMessagesPerDay;
  }

  async plan(userId: string, now = new Date()): Promise<PlanDto> {
    const row = await this.entitlement(userId);
    if (!row) return { tier: 'free', status: null, expiresAt: null, willRenew: null, store: null };
    return {
      tier: isPlusState(row, now) ? 'plus' : 'free',
      status: row.status,
      expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
      willRenew: row.willRenew ?? null,
      store: row.store,
    };
  }

  /** Compares the webhook's Authorization header with REVENUECAT_WEBHOOK_AUTH in constant time. */
  webhookAuthorized(header: string | string[] | undefined): boolean {
    const expected = this.config.webhookAuth;
    const given = Array.isArray(header) ? header[0] : header;
    if (!expected || typeof given !== 'string') return false;
    // Equal-length digests, so the comparison time doesn't depend on where the values differ.
    return timingSafeEqual(digest(given), digest(expected));
  }

  /**
   * Applies a RevenueCat webhook (already authenticated). Idempotent on the event id. Unknown app
   * user ids are ignored (nothing created). After the event, the subscriber is re-read from the
   * REST API and that state stored; a REST failure keeps the event's own data.
   */
  async handleWebhook(body: unknown): Promise<WebhookOutcome> {
    const event = (body as { event?: unknown } | null)?.event as RevenueCatEvent | undefined;
    if (!event || typeof event.id !== 'string' || !event.id || event.id.length > 200 || typeof event.type !== 'string') {
      throw new AppError('VALIDATION', 'Not a RevenueCat webhook event', { event: 'event.id and event.type are required' });
    }
    if (event.type === 'TEST') {
      this.logger.log(`RevenueCat test webhook ${event.id}`);
      return 'test';
    }
    if (!HANDLED_EVENTS.includes(event.type)) {
      this.logger.warn(`RevenueCat webhook ${event.id}: unknown type ${event.type.slice(0, 50)}, ignored`);
      return 'ignored';
    }
    if (!concernsEntitlement(event, this.config.entitlementId)) {
      this.logger.log(`RevenueCat webhook ${event.id} (${event.type}) is for another entitlement, ignored`);
      return 'ignored';
    }

    const candidates =
      event.type === 'TRANSFER'
        ? [...(event.transferred_from ?? []), ...(event.transferred_to ?? [])]
        : [event.app_user_id ?? ''];
    const known = await this.knownUsers(candidates);
    if (known.size === 0) {
      this.logger.warn(`RevenueCat webhook ${event.id} (${event.type}) for an unknown app user id, ignored`);
      return 'ignored';
    }

    try {
      await this.entitlements.manager.transaction(async (manager) => {
        // First, so a second delivery fails here (unique key) and changes nothing.
        await manager.insert(BillingEvent, { eventId: event.id, type: event.type, appUserId: event.app_user_id ?? null });
        const ids = [...known].sort();
        for (const id of ids) await manager.query(ADVISORY_XACT_LOCK, [`billing:user:${id}`]);
        if (event.type === 'TRANSFER') await this.transfer(manager, event, known);
        else {
          const current = await this.entitlement(ids[0], manager);
          const next = stateAfterEvent(current, event);
          if (next) await this.write(manager, ids[0], next, event.id);
        }
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      this.logger.log(`RevenueCat webhook ${event.id} already applied`);
      return 'duplicate';
    }
    this.logger.log(`RevenueCat webhook ${event.id} (${event.type}) applied for ${[...known].join(', ')}`);
    for (const id of known) await this.refresh(id);
    return 'applied';
  }

  /**
   * `POST /subscription/sync`: re-reads the caller from RevenueCat and stores it (mock: the local
   * table only). 20 per user per hour; a RevenueCat outage → BILLING_UNAVAILABLE, plan unchanged.
   */
  async sync(user: AuthUser, now = new Date()): Promise<PlanDto> {
    this.takeSyncSlot(user.id, now.getTime());
    if (this.provider.name !== 'mock') {
      let subscriber: RevenueCatSubscriber | null;
      try {
        subscriber = await this.provider.getSubscriber(user.id);
      } catch (error) {
        this.logger.warn(`Billing sync failed for user ${user.id}: ${(error as Error).message}`);
        throw new AppError('BILLING_UNAVAILABLE', 'Billing is unavailable right now. Please try again in a moment.');
      }
      if (subscriber) await this.applySubscriber(user.id, subscriber, now);
    }
    return this.plan(user.id, now);
  }

  /** DEV ONLY (dev-grant route): sets the caller's own plan. */
  async devGrant(user: AuthUser, tier: 'plus' | 'free', expiresInDays?: number, now = new Date()): Promise<PlanDto> {
    await this.entitlements.manager.transaction(async (manager) => {
      await manager.query(ADVISORY_XACT_LOCK, [`billing:user:${user.id}`]);
      const current = await this.entitlement(user.id, manager);
      if (tier === 'plus') {
        await this.write(manager, user.id, {
          store: 'dev',
          productId: 'dev',
          status: 'active',
          expiresAt: expiresInDays ? new Date(now.getTime() + expiresInDays * DAY_MS) : null,
          willRenew: false,
        });
      } else if (current) {
        await this.write(manager, user.id, { ...current, status: 'expired', expiresAt: now, willRenew: false });
      }
    });
    this.logger.log(`Dev grant: user ${user.id} set to ${tier}`);
    return this.plan(user.id, now);
  }

  /** Users (by id) that exist and aren't deleted; anything else is dropped. */
  private async knownUsers(ids: string[]): Promise<Set<string>> {
    const known = new Set<string>();
    for (const id of new Set(ids.filter((v) => typeof v === 'string'))) {
      if (isUUID(id) && (await this.users.findActive(id.toLowerCase()))) known.add(id.toLowerCase());
    }
    return known;
  }

  /** TRANSFER: the entitlement moves from the `transferred_from` users to the `transferred_to` ones. */
  private async transfer(manager: EntityManager, event: RevenueCatEvent, known: Set<string>): Promise<void> {
    const lower = (list?: string[] | null) => (list ?? []).map((id) => id.toLowerCase()).filter((id) => known.has(id));
    const from = lower(event.transferred_from);
    const to = lower(event.transferred_to);
    let source: UserEntitlement | null = null;
    for (const id of from) {
      const row = await this.entitlement(id, manager);
      if (!row) continue;
      source ??= row;
      await this.write(manager, id, { ...row, status: 'expired', willRenew: false }, event.id);
    }
    for (const id of to) {
      if (source) {
        await this.write(
          manager,
          id,
          { store: source.store, productId: source.productId, status: source.status, expiresAt: source.expiresAt, willRenew: source.willRenew },
          event.id,
        );
      }
    }
  }

  /** After a webhook: REST is the source of truth. A failure keeps the event's own data. */
  private async refresh(userId: string): Promise<void> {
    if (this.provider.name === 'mock') return;
    try {
      const subscriber = await this.provider.getSubscriber(userId);
      if (subscriber) await this.applySubscriber(userId, subscriber, new Date());
    } catch (error) {
      this.logger.warn(`RevenueCat re-read failed for user ${userId}, keeping the webhook data: ${(error as Error).message}`);
    }
  }

  private async applySubscriber(userId: string, subscriber: RevenueCatSubscriber, now: Date): Promise<void> {
    await this.entitlements.manager.transaction(async (manager) => {
      await manager.query(ADVISORY_XACT_LOCK, [`billing:user:${userId}`]);
      const current = await this.entitlement(userId, manager);
      const state = stateFromSubscriber(subscriber, this.config.entitlementId, now);
      if (state) await this.write(manager, userId, state);
      // No such entitlement any more: it lapsed (dev grants aren't RevenueCat's to remove).
      else if (current && current.store !== 'dev' && current.status !== 'expired') {
        await this.write(manager, userId, { ...current, status: 'expired', willRenew: false });
      }
    });
  }

  private async write(manager: EntityManager, userId: string, state: EntitlementState, eventId?: string): Promise<void> {
    const values = {
      store: state.store,
      productId: state.productId,
      status: state.status,
      expiresAt: state.expiresAt,
      willRenew: state.willRenew,
      ...(eventId ? { lastEventId: eventId } : {}),
    };
    const where = { userId, entitlement: this.config.entitlementId };
    const { affected } = await manager.update(UserEntitlement, where, values);
    if (!affected) await manager.insert(UserEntitlement, { ...where, ...values, lastEventId: eventId ?? null });
  }

  private takeSyncSlot(userId: string, now: number): void {
    const { max, windowMs } = SYNC_RATE_LIMIT;
    const recent = (this.syncs.get(userId) ?? []).filter((t) => t > now - windowMs);
    if (recent.length >= max) {
      this.syncs.set(userId, recent);
      throw new AppError('RATE_LIMITED', 'Too many subscription syncs. Please wait a little.', undefined, {
        retryAfterSeconds: (recent[recent.length - max] + windowMs - now) / 1000,
      });
    }
    recent.push(now);
    this.syncs.delete(userId);
    if (this.syncs.size >= MAX_TRACKED_SYNCERS) this.syncs.delete(this.syncs.keys().next().value!);
    this.syncs.set(userId, recent);
  }
}
