import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, In, MoreThanOrEqual, Repository } from 'typeorm';
import { AppError } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { CreateAppTripDto } from '../app-trips/dto/create-app-trip.dto.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween } from '../trips/dto/date-rules.js';
import { AI_CONFIG } from './ai.config.js';
import type { AiConfig } from './ai.config.js';
import { MAX_LISTED_CONVERSATIONS, MAX_USER_MESSAGES_PER_CONVERSATION, RATE_LIMITS } from './ai.types.js';
import type { AiConversationDto, AiTurnDto, DraftPlace, TripDraft, TripPlaceDto } from './ai.types.js';
import { compareTripPlaces, toConversationDto, toTripPlaceDto, toTurnDto } from './ai.mapper.js';
import { MODEL_DRAFT_SCHEMA, normalizeDraft, parseModelDraft, replayText } from './draft.js';
import type { ModelDraft } from './draft.js';
import { buildSystemPrompt } from './prompt.js';
import type { LinkedTripContext } from './prompt.js';
import { AiConversation } from './entities/ai-conversation.entity.js';
import { AiMessage } from './entities/ai-message.entity.js';
import { TripPlace } from './entities/trip-place.entity.js';
import { AiUnavailableError, LLM_PROVIDER } from './llm/llm-provider.js';
import type { LlmHistoryEntry, LlmProvider } from './llm/llm-provider.js';
import { PlacesVerifier } from './places/places-verifier.js';

const conversationNotFound = () => new AppError('NOT_FOUND', 'Conversation not found');
const notOpen = (status: string) => new AppError('CONFLICT', `This plan is ${status}; start a new one`);
const aiUnavailable = () =>
  new AppError('AI_UNAVAILABLE', 'The trip planner is unavailable right now. Please try again in a moment.');

/** Overall budget for one turn: per-call timeout × (1 + retries) × (1 + the max_tokens/invalid-output retry). */
const TURN_BUDGET_FACTOR = 6;

/** Another request confirmed the conversation first; the transaction rolls back. */
class ConfirmRaceError extends Error {}

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * AI trip planning. Conversations belong to their author only: anyone else gets NOT_FOUND, even
 * for a conversation linked to a trip they're a member of. Inputs are validated by the DTOs first.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @InjectRepository(AiConversation) private readonly conversations: Repository<AiConversation>,
    @InjectRepository(AiMessage) private readonly messages: Repository<AiMessage>,
    @InjectRepository(TripPlace) private readonly places: Repository<TripPlace>,
    @InjectRepository(Trip) private readonly trips: Repository<Trip>,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(AI_CONFIG) private readonly config: AiConfig,
    private readonly verifier: PlacesVerifier,
    private readonly appTrips: AppTripsService,
  ) {}

  /** Starts a conversation with its first message. With `tripId`, the caller must be owner or editor. */
  async start(
    user: AuthUser,
    locale: Locale,
    input: { message: string; tripId?: string },
  ): Promise<{ conversation: AiConversationDto; turn: AiTurnDto }> {
    const linked = input.tripId ? (await this.appTrips.requireMembership(user, input.tripId, ['owner', 'editor'])).trip! : null;
    await this.checkRateLimit(user.id);

    const conversation = await this.conversations.save(
      this.conversations.create({
        userId: user.id,
        tripId: linked?.id ?? null,
        status: 'open',
        title: linked ? linked.destination.slice(0, 100) : null,
      }),
    );
    const first = await this.messages.save(
      this.messages.create({ conversationId: conversation.id, role: 'user', text: input.message, draft: null }),
    );
    const turn = await this.reply(conversation, locale, [first]);
    const updated = await this.conversations.findOneBy({ id: conversation.id });
    return { conversation: toConversationDto(updated ?? conversation), turn };
  }

  /**
   * Adds a user message and returns the assistant's turn. Sending the same text again right after
   * a failed turn retries it without storing (or counting) the message twice.
   */
  async post(user: AuthUser, locale: Locale, conversationId: string, message: string): Promise<AiTurnDto> {
    const conversation = await this.requireConversation(user, conversationId);
    if (conversation.status !== 'open') throw notOpen(conversation.status);

    const history = await this.history(conversation.id);
    const last = history.at(-1);
    const retry = last?.role === 'user' && last.text === message;
    if (!retry) {
      const sent = history.filter((m) => m.role === 'user').length;
      if (sent >= MAX_USER_MESSAGES_PER_CONVERSATION) {
        throw new AppError('CONFLICT', 'This plan has reached its message limit; start a new plan');
      }
      await this.checkRateLimit(user.id);
      history.push(
        await this.messages.save(this.messages.create({ conversationId: conversation.id, role: 'user', text: message, draft: null })),
      );
      // Keeps the conversation inside the rate-limit query window even if the reply fails.
      await this.conversations.update({ id: conversation.id }, { updatedAt: new Date() });
    }
    return this.reply(conversation, locale, history);
  }

  /** The user's conversations, most recently active first. */
  async list(user: AuthUser): Promise<AiConversationDto[]> {
    const rows = await this.conversations.find({
      where: { userId: user.id },
      order: { updatedAt: 'DESC', createdAt: 'DESC' },
      take: MAX_LISTED_CONVERSATIONS,
    });
    return rows.map(toConversationDto);
  }

  async get(user: AuthUser, conversationId: string): Promise<{ conversation: AiConversationDto; turns: AiTurnDto[] }> {
    const conversation = await this.requireConversation(user, conversationId);
    return { conversation: toConversationDto(conversation), turns: (await this.history(conversation.id)).map(toTurnDto) };
  }

  async abandon(user: AuthUser, conversationId: string): Promise<void> {
    const conversation = await this.requireConversation(user, conversationId);
    if (conversation.status !== 'open') throw notOpen(conversation.status);
    const { affected } = await this.conversations.update({ id: conversation.id, status: 'open' }, { status: 'abandoned' });
    if (!affected) throw new AppError('CONFLICT', 'This plan is no longer open');
  }

  /**
   * Turns the latest ready draft into a trip with its verified places (`created: true`), or adds
   * the places to the linked trip (`created: false`). Idempotent: once confirmed, it returns the
   * same trip without adding anything.
   */
  async confirm(user: AuthUser, conversationId: string): Promise<{ trip: AppTripDto; created: boolean }> {
    const conversation = await this.requireConversation(user, conversationId);
    if (conversation.status === 'confirmed') return this.confirmedTrip(user, conversation);
    if (conversation.status !== 'open') throw notOpen(conversation.status);

    const draft = (await this.history(conversation.id)).filter((m) => m.role === 'assistant').at(-1)?.draft ?? null;
    if (!draft?.ready) throw new AppError('CONFLICT', "The plan isn't ready yet: it needs a destination and dates");
    const verified = draft.places.filter((p) => p.verified && p.place);

    try {
      if (conversation.tripId) {
        const tripId = conversation.tripId;
        // The role is checked again: it may have changed since the conversation started.
        await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
        await this.conversations.manager.transaction(async (manager) => {
          await this.claim(manager, conversation.id, tripId);
          await this.insertPlaces(manager, tripId, user.id, verified);
        });
        return { trip: await this.appTrips.get(user, tripId), created: false };
      }

      const fields: Record<string, unknown> = {
        destination: draft.destination,
        startDate: draft.startDate,
        endDate: draft.endDate,
        story: draft.story ?? undefined,
        partyType: draft.partyType ?? undefined,
        partySize: draft.partySize ?? undefined,
      };
      // The same validation as POST /trips.
      const data = (await appValidationPipe.transform(fields, { type: 'body', metatype: CreateAppTripDto })) as CreateAppTripDto;
      const trip = await this.appTrips.create(user, data, async (manager, created) => {
        await this.claim(manager, conversation.id, created.id);
        await this.insertPlaces(manager, created.id, user.id, verified);
      });
      return { trip, created: true };
    } catch (error) {
      if (!(error instanceof ConfirmRaceError)) throw error;
      const latest = await this.requireConversation(user, conversation.id);
      if (latest.status === 'confirmed') return this.confirmedTrip(user, latest);
      throw notOpen(latest.status);
    }
  }

  /** Places of a trip the user is a member of, by day then name. */
  async listPlaces(user: AuthUser, tripId: string): Promise<TripPlaceDto[]> {
    await this.appTrips.requireMembership(user, tripId);
    const rows = await this.places.find({ where: { tripId } });
    return rows.sort(compareTripPlaces).map(toTripPlaceDto);
  }

  /** Owners and editors only. */
  async deletePlace(user: AuthUser, tripId: string, placeId: string): Promise<void> {
    await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const notFound = () => new AppError('NOT_FOUND', 'Place not found');
    if (!isUUID(placeId, '4')) throw notFound();
    const { affected } = await this.places.delete({ id: placeId, tripId });
    if (!affected) throw notFound();
  }

  /** Account deletion: the user's conversations go; the places they added stay with their trips. */
  async handleUserDeleted(userId: string): Promise<void> {
    await this.conversations.delete({ userId });
    await this.places.update({ createdBy: userId }, { createdBy: null });
  }

  /** The user's own conversation. Anyone else's (or a malformed id) is NOT_FOUND, never FORBIDDEN. */
  private async requireConversation(user: AuthUser, conversationId: string): Promise<AiConversation> {
    if (!isUUID(conversationId, '4')) throw conversationNotFound();
    const conversation = await this.conversations.findOne({ where: { id: conversationId, userId: user.id } });
    if (!conversation) throw conversationNotFound();
    return conversation;
  }

  private history(conversationId: string): Promise<AiMessage[]> {
    return this.messages.find({ where: { conversationId }, order: { createdAt: 'ASC' } });
  }

  private async confirmedTrip(user: AuthUser, conversation: AiConversation): Promise<{ trip: AppTripDto; created: boolean }> {
    if (!conversation.tripId) throw new AppError('CONFLICT', 'The trip of this plan was deleted');
    return { trip: await this.appTrips.get(user, conversation.tripId), created: false };
  }

  /** Marks the conversation confirmed, only if it's still open (a concurrent confirm loses). */
  private async claim(manager: EntityManager, conversationId: string, tripId: string): Promise<void> {
    const { affected } = await manager.update(AiConversation, { id: conversationId, status: 'open' }, { status: 'confirmed', tripId });
    if (!affected) throw new ConfirmRaceError();
  }

  /** Inserts verified places the trip doesn't have yet (one per Google place). */
  private async insertPlaces(manager: EntityManager, tripId: string, userId: string, places: DraftPlace[]): Promise<void> {
    const existing = await manager.find(TripPlace, { where: { tripId } });
    const seen = new Set(existing.map((p) => p.googlePlaceId));
    for (const draftPlace of places) {
      const place = draftPlace.place!;
      if (seen.has(place.googlePlaceId)) continue;
      seen.add(place.googlePlaceId);
      await manager.insert(TripPlace, {
        tripId,
        googlePlaceId: place.googlePlaceId,
        name: draftPlace.name,
        category: draftPlace.category,
        day: draftPlace.day,
        notes: draftPlace.why || null,
        address: place.address,
        lat: place.lat,
        lng: place.lng,
        rating: place.rating,
        mapsUrl: place.mapsUrl,
        types: place.types,
        source: 'ai',
        createdBy: userId,
      });
    }
  }

  /**
   * Per user: 30 messages per rolling hour and 150 per rolling 24 h, counted from stored user
   * messages. Retry-After is when the oldest message that counts leaves the window.
   */
  private async checkRateLimit(userId: string): Promise<void> {
    const now = Date.now();
    const since = new Date(now - Math.max(...RATE_LIMITS.map((l) => l.windowMs)));
    // A user message bumps its conversation's updatedAt, so older conversations can't hold any.
    const recent = await this.conversations.find({ where: { userId, updatedAt: MoreThanOrEqual(since) } });
    if (recent.length === 0) return;
    const sent = await this.messages.find({
      where: { conversationId: In(recent.map((c) => c.id)), role: 'user', createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'ASC' },
    });
    for (const { windowMs, max } of RATE_LIMITS) {
      const inWindow = sent.filter((m) => new Date(m.createdAt).getTime() >= now - windowMs);
      if (inWindow.length < max) continue;
      const oldestCounted = new Date(inWindow[inWindow.length - max].createdAt).getTime();
      throw new AppError('RATE_LIMITED', 'Too many messages to the trip planner. Please wait a little.', undefined, {
        retryAfterSeconds: (oldestCounted + windowMs - now) / 1000,
      });
    }
  }

  /** Asks the model for the next turn, verifies its places and stores it. */
  private async reply(conversation: AiConversation, locale: Locale, history: AiMessage[]): Promise<AiTurnDto> {
    const linkedTrip = await this.linkedTrip(conversation);
    const previous = history.filter((m) => m.role === 'assistant').at(-1)?.draft ?? null;
    const entries = toLlmHistory(history);
    const startedAt = Date.now();
    const signal = AbortSignal.timeout(this.config.timeoutMs * TURN_BUDGET_FACTOR);

    let model: ModelDraft | null = null;
    let correction: string | undefined;
    let usage = { model: this.config.model, inputTokens: 0, outputTokens: 0 };
    try {
      // One retry when the output doesn't match the schema, naming the problem.
      for (let attempt = 0; attempt < 2 && !model; attempt += 1) {
        const system = buildSystemPrompt({ today: todayUtc(), locale, linkedTrip, correction });
        const result = await this.llm.draftTurn({ system, history: entries, schema: MODEL_DRAFT_SCHEMA, signal });
        usage = {
          model: result.model,
          inputTokens: usage.inputTokens + result.inputTokens,
          outputTokens: usage.outputTokens + result.outputTokens,
        };
        const parsed = await parseModelDraft(result.json);
        if ('draft' in parsed) model = parsed.draft;
        else {
          correction = parsed.problem;
          this.logger.warn(`AI conversation ${conversation.id}: invalid output (attempt ${attempt + 1})`);
        }
      }
      if (!model) throw new AiUnavailableError(`${this.llm.name}: invalid output after retry`);
    } catch (error) {
      if (!(error instanceof AiUnavailableError)) throw error;
      this.logger.warn(`AI conversation ${conversation.id}: ${error.reason} (${Date.now() - startedAt} ms)`);
      throw aiUnavailable();
    }

    const draft = normalizeDraft(model);
    if (linkedTrip) applyLinkedTrip(draft, linkedTrip);
    draft.places = await this.verifier.verify(conversation.id, locale, draft, previous);

    const saved = await this.messages.save(
      this.messages.create({
        conversationId: conversation.id,
        role: 'assistant',
        text: model.reply,
        draft,
        provider: this.llm.name,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
    );
    await this.conversations.update(
      { id: conversation.id },
      { title: draft.destination?.slice(0, 100) ?? conversation.title, updatedAt: new Date() },
    );
    // Ids, provider, model, counts and latency only: never message text.
    this.logger.log(
      `AI turn conversation=${conversation.id} provider=${this.llm.name} model=${usage.model} ` +
        `inputTokens=${usage.inputTokens} outputTokens=${usage.outputTokens} places=${draft.places.length} ` +
        `latencyMs=${Date.now() - startedAt}`,
    );
    return toTurnDto(saved);
  }

  private async linkedTrip(conversation: AiConversation): Promise<LinkedTripContext | null> {
    if (!conversation.tripId) return null;
    const trip = await this.trips.findOneBy({ id: conversation.tripId });
    return trip ? { destination: trip.destination, startDate: trip.startDate, endDate: trip.endDate } : null;
  }
}

/** Stored turns as model history: assistant turns as their JSON, consecutive user turns merged. */
export function toLlmHistory(messages: AiMessage[]): LlmHistoryEntry[] {
  const entries: LlmHistoryEntry[] = [];
  for (const message of messages) {
    const text = message.role === 'assistant' ? replayText(message.text, message.draft) : message.text;
    const last = entries.at(-1);
    if (last && last.role === 'user' && message.role === 'user') last.text = `${last.text}\n\n${text}`;
    else entries.push({ role: message.role, text });
  }
  return entries;
}

/** A linked trip keeps its destination and dates: the conversation only adds places. */
function applyLinkedTrip(draft: TripDraft, trip: LinkedTripContext): void {
  const days = daysBetween(trip.startDate, trip.endDate) + 1;
  draft.destination = trip.destination;
  draft.startDate = trip.startDate;
  draft.endDate = trip.endDate;
  draft.ready = true;
  for (const place of draft.places) if (place.day !== null && place.day > days) place.day = null;
}
