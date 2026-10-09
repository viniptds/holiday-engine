import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { EntityManager, In, Repository } from 'typeorm';
import { AppError, conflict } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import type { Locale } from '../app-common/locale.js';
import { RateWindow } from '../app-common/rate-window.js';
import { AppTripsService } from '../app-trips/app-trips.service.js';
import { AI_CONFIG } from '../ai/ai.config.js';
import type { AiConfig } from '../ai/ai.config.js';
import { CHECKLIST_SUGGESTIONS_SCHEMA } from '../ai/checklist-schema.js';
import { AiUnavailableError, LLM_PROVIDER } from '../ai/llm/llm-provider.js';
import type { LlmProvider } from '../ai/llm/llm-provider.js';
import { REPLY_LANGUAGE_PREFIX } from '../ai/prompt.js';
import { singleLine } from '../mail/templates/escape.js';
import { Trip } from '../trips/trip.entity.js';
import { daysBetween } from '../trips/dto/date-rules.js';
import { CHECKLIST_CATEGORIES, CHECKLIST_PRIORITIES, ChecklistItem, ChecklistReminder } from './checklist.entities.js';
import type { ChecklistCategory, ChecklistPriority } from './checklist.entities.js';
import { CreateChecklistItemDto, PatchChecklistItemDto } from './checklist.dto.js';

export const MAX_CHECKLIST_ITEMS = 200;
export const MAX_SUGGESTIONS = 25;
const DAY_MS = 86_400_000;
export const SUGGESTION_LIMITS = { perTrip: 5, perUser: 20, windowMs: DAY_MS };
const ADVISORY_XACT_LOCK = 'SELECT pg_advisory_xact_lock(hashtext($1))';

export type ChecklistItemDto = {
  id: string; title: string; notes: string | null; priority: ChecklistPriority; category: ChecklistCategory;
  done: boolean; doneBy: string | null; doneAt: string | null; position: number; source: 'ai' | 'user';
  createdBy: string | null; createdAt: string; updatedAt: string;
};
export type ReminderDto = { itemId: string; remindAt: string; sentAt: string | null };
export type SuggestionDto = { title: string; notes: string; priority: ChecklistPriority; category: ChecklistCategory };

const itemNotFound = () => new AppError('NOT_FOUND', 'Checklist item not found');
const invalid = (fields: Record<string, string>) => new AppError('VALIDATION', 'Some fields are invalid', fields);
const full = () => conflict('CHECKLIST_FULL', `A trip's checklist holds at most ${MAX_CHECKLIST_ITEMS} items`);
const LANGUAGE_NAMES: Record<Locale, string> = { en: 'English', 'pt-BR': 'Brazilian Portuguese', es: 'Spanish' };
const key = (title: string) => singleLine(title).toLowerCase();

/**
 * A trip's shared checklist (docs/app-notifications-checklist-calendar-spec.md): members read it,
 * owners and editors change it; reminders are personal (any member, for themselves). Editing or
 * checking items notifies nobody.
 */
@Injectable()
export class ChecklistService {
  private readonly logger = new Logger(ChecklistService.name);
  private readonly tripSuggestions = new RateWindow(SUGGESTION_LIMITS.perTrip, SUGGESTION_LIMITS.windowMs, 'This trip has had enough suggestions for today. Try again later.');
  private readonly userSuggestions = new RateWindow(SUGGESTION_LIMITS.perUser, SUGGESTION_LIMITS.windowMs, 'You have asked for enough suggestions for today. Try again later.');

  constructor(
    @InjectRepository(ChecklistItem) private readonly items: Repository<ChecklistItem>,
    @InjectRepository(ChecklistReminder) private readonly reminders: Repository<ChecklistReminder>,
    private readonly appTrips: AppTripsService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @Inject(AI_CONFIG) private readonly ai: AiConfig,
  ) {}

  async list(user: AuthUser, tripId: string): Promise<{ items: ChecklistItemDto[]; myReminders: ReminderDto[] }> {
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    const items = await this.items.find({ where: { tripId: trip!.id }, order: { position: 'ASC', createdAt: 'ASC' } });
    const reminders = items.length ? await this.reminders.find({ where: { userId: user.id, itemId: In(items.map((i) => i.id)) } }) : [];
    return { items: items.map(toItemDto), myReminders: reminders.map(toReminderDto) };
  }

  async create(user: AuthUser, tripId: string, data: CreateChecklistItemDto): Promise<ChecklistItemDto> {
    const [item] = await this.add(user, tripId, [data], 'user');
    return item;
  }

  /** Adds picked suggestions (source `ai`), all or none: past the 200 cap → 409 CHECKLIST_FULL. */
  async bulk(user: AuthUser, tripId: string, data: CreateChecklistItemDto[]): Promise<ChecklistItemDto[]> {
    return this.add(user, tripId, data, 'ai');
  }

  async patch(user: AuthUser, tripId: string, itemId: string, data: PatchChecklistItemDto): Promise<ChecklistItemDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const item = await this.requireItem(trip!.id, itemId);
    const changes: Partial<ChecklistItem> = {};
    if (data.title !== undefined) changes.title = this.title(data.title, 'title');
    if (data.notes !== undefined) changes.notes = data.notes === null ? null : data.notes.trim() || null;
    if (data.priority !== undefined) changes.priority = data.priority;
    if (data.category !== undefined) changes.category = data.category;
    if (data.done !== undefined && data.done !== item.done) {
      Object.assign(changes, data.done ? { done: true, doneBy: user.id, doneAt: new Date() } : { done: false, doneBy: null, doneAt: null });
    }
    if (Object.keys(changes).length) await this.items.update({ id: item.id }, changes);
    return toItemDto((await this.items.findOne({ where: { id: item.id } }))!);
  }

  async delete(user: AuthUser, tripId: string, itemId: string): Promise<void> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const item = await this.requireItem(trip!.id, itemId);
    await this.items.delete({ id: item.id });
  }

  /** Every item of the trip exactly once, in the new order (positions 0…n-1). */
  async order(user: AuthUser, tripId: string, itemIds: string[]): Promise<ChecklistItemDto[]> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    await this.items.manager.transaction(async (manager) => {
      await manager.query(ADVISORY_XACT_LOCK, [`checklist:trip:${trip!.id}`]);
      const items = await manager.find(ChecklistItem, { where: { tripId: trip!.id } });
      const ids = itemIds.map((id) => id.toLowerCase());
      const known = new Set(items.map((i) => i.id));
      if (new Set(ids).size !== ids.length) throw invalid({ itemIds: 'an item is listed more than once' });
      if (ids.length !== items.length || ids.some((id) => !known.has(id))) throw invalid({ itemIds: 'list every item of the checklist exactly once' });
      for (const [position, id] of ids.entries()) {
        if (items.find((i) => i.id === id)!.position !== position) await manager.update(ChecklistItem, { id }, { position });
      }
    });
    return (await this.list(user, tripId)).items;
  }

  /** Any member, for themselves; `remindAt` must be in the future. Replacing one resets it to unsent. */
  async setReminder(user: AuthUser, tripId: string, itemId: string, remindAt: string, now = new Date()): Promise<ReminderDto> {
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    const item = await this.requireItem(trip!.id, itemId);
    const at = new Date(remindAt);
    if (at.getTime() <= now.getTime()) throw invalid({ remindAt: 'remindAt must be in the future' });
    await this.reminders.save(this.reminders.create({ itemId: item.id, userId: user.id, remindAt: at, sentAt: null }));
    return toReminderDto((await this.reminders.findOne({ where: { itemId: item.id, userId: user.id } }))!);
  }

  async removeReminder(user: AuthUser, tripId: string, itemId: string): Promise<void> {
    const { trip } = await this.appTrips.requireMembership(user, tripId);
    const item = await this.requireItem(trip!.id, itemId);
    await this.reminders.delete({ itemId: item.id, userId: user.id });
  }

  /**
   * AI suggestions (not saved), in `locale`, through the LLM provider's structured output. Owners
   * and editors; not counted against the AI quota; 5 per trip and 20 per user a day (RATE_LIMITED).
   */
  async suggest(user: AuthUser, tripId: string, locale: Locale): Promise<SuggestionDto[]> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    this.tripSuggestions.assertRoom(trip!.id);
    this.userSuggestions.assertRoom(user.id);
    this.tripSuggestions.take(trip!.id);
    this.userSuggestions.take(user.id);

    const existing = await this.items.find({ where: { tripId: trip!.id } });
    let json: unknown;
    try {
      ({ json } = await this.llm.draftTurn({
        system: this.prompt(trip!, locale),
        history: [{ role: 'user', text: `Existing items (don't repeat them): ${JSON.stringify(existing.map((i) => i.title))}` }],
        schema: CHECKLIST_SUGGESTIONS_SCHEMA,
        signal: AbortSignal.timeout(this.ai.timeoutMs),
      }));
    } catch (error) {
      const reason = error instanceof AiUnavailableError ? error.reason : (error as Error).name;
      this.logger.warn(`Checklist suggestions for trip ${trip!.id} failed (${this.llm.name}): ${reason}`);
      throw new AppError('AI_UNAVAILABLE', 'The checklist assistant is unavailable right now. Please try again in a moment.');
    }
    const seen = new Set(existing.map((i) => key(i.title)));
    const suggestions: SuggestionDto[] = [];
    for (const raw of ((json as { items?: unknown[] })?.items ?? []) as Record<string, unknown>[]) {
      const title = typeof raw?.title === 'string' ? singleLine(raw.title).slice(0, 120) : '';
      if (!title || seen.has(key(title))) continue;
      seen.add(key(title));
      suggestions.push({
        title,
        notes: typeof raw.notes === 'string' ? raw.notes.trim().slice(0, 500) : '',
        priority: (CHECKLIST_PRIORITIES as readonly string[]).includes(raw.priority as string) ? (raw.priority as ChecklistPriority) : 'medium',
        category: (CHECKLIST_CATEGORIES as readonly string[]).includes(raw.category as string) ? (raw.category as ChecklistCategory) : 'other',
      });
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }
    this.logger.log(`Checklist suggestions for trip ${trip!.id}: ${suggestions.length} item(s) (${this.llm.name})`);
    return suggestions;
  }

  private prompt(trip: Trip, locale: Locale): string {
    const days = daysBetween(trip.startDate, trip.endDate) + 1;
    const month = new Intl.DateTimeFormat('en', { month: 'long', timeZone: 'UTC' }).format(new Date(`${trip.startDate}T00:00:00Z`));
    const answers = trip.travelerProfile?.answers ? JSON.stringify(trip.travelerProfile.answers) : 'none';
    return [
      'You prepare a practical pre-trip checklist for a traveler. Return 10 to 25 items that matter for THIS trip:',
      'documents and entry rules, health, money, bookings, tech and packing for the season and destination. No duplicates, no items already listed.',
      'Each item: a short action title (at most 120 characters), one helpful sentence of notes or an empty string, a priority (high for anything that blocks the trip) and a category.',
      `Destination: ${singleLine(trip.destination)}${trip.countryCode ? ` (country ${trip.countryCode})` : ''}.`,
      `Dates: ${trip.startDate} to ${trip.endDate} (${days} day${days === 1 ? '' : 's'}, starting in ${month}; consider the season there).`,
      `Party: ${trip.partyType ?? 'unknown'}${trip.partySize ? `, ${trip.partySize} people` : ''}. Traveler answers: ${answers}.`,
      `${REPLY_LANGUAGE_PREFIX}${locale} (${LANGUAGE_NAMES[locale]}). Write titles and notes in that language, informally ("você" in Brazilian Portuguese, "tú" in neutral Spanish).`,
    ].join('\n');
  }

  private async add(user: AuthUser, tripId: string, data: CreateChecklistItemDto[], source: 'ai' | 'user'): Promise<ChecklistItemDto[]> {
    const { trip } = await this.appTrips.requireMembership(user, tripId, ['owner', 'editor']);
    const rows = data.map((d, i) => ({
      title: this.title(d.title, data.length > 1 ? `items.${i}.title` : 'title'),
      notes: d.notes?.trim() || null,
      priority: d.priority ?? 'medium',
      category: d.category ?? 'other',
    }));
    const ids = await this.items.manager.transaction(async (manager: EntityManager) => {
      await manager.query(ADVISORY_XACT_LOCK, [`checklist:trip:${trip!.id}`]);
      const current = await manager.find(ChecklistItem, { where: { tripId: trip!.id } });
      if (current.length + rows.length > MAX_CHECKLIST_ITEMS) throw full();
      let position = current.reduce((max, i) => Math.max(max, i.position + 1), 0);
      const created: string[] = [];
      for (const row of rows) {
        const saved = await manager.save(manager.create(ChecklistItem, { ...row, tripId: trip!.id, done: false, doneBy: null, doneAt: null, position: position++, source, createdBy: user.id }));
        created.push(saved.id);
      }
      return created;
    });
    const saved = await this.items.find({ where: { id: In(ids) } });
    return ids.map((id) => toItemDto(saved.find((s) => s.id === id)!));
  }

  private title(value: string, field: string): string {
    const title = singleLine(value);
    if (!title) throw invalid({ [field]: 'title must not be empty' });
    return title;
  }

  private async requireItem(tripId: string, itemId: string): Promise<ChecklistItem> {
    if (!isUUID(itemId, '4')) throw itemNotFound();
    const item = await this.items.findOne({ where: { id: itemId.toLowerCase(), tripId } });
    if (!item) throw itemNotFound();
    return item;
  }
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toItemDto(i: ChecklistItem): ChecklistItemDto {
  return {
    id: i.id, title: i.title, notes: i.notes ?? null, priority: i.priority, category: i.category, done: !!i.done,
    doneBy: i.doneBy ?? null, doneAt: iso(i.doneAt), position: i.position, source: i.source, createdBy: i.createdBy ?? null,
    createdAt: new Date(i.createdAt).toISOString(), updatedAt: new Date(i.updatedAt).toISOString(),
  };
}

function toReminderDto(r: ChecklistReminder): ReminderDto {
  return { itemId: r.itemId, remindAt: new Date(r.remindAt).toISOString(), sentAt: iso(r.sentAt) };
}
