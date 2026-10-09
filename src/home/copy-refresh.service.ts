import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { Repository } from 'typeorm';
import type { Locale } from '../app-common/locale.js';
import { AiUnavailableError, LLM_PROVIDER } from '../ai/llm/llm-provider.js';
import type { LlmProvider } from '../ai/llm/llm-provider.js';
import { BannersService } from './banners.service.js';
import { DestinationCatalog } from './catalog.js';
import { copyProblems, countryName } from './copy.js';
import type { HomeConfig } from './home.config.js';
import { HOME_COPY_DESTINATION_PREFIX, HOME_COPY_SCHEMA } from './home-copy-schema.js';
import { HomeCopy } from './home-copy.entity.js';
import type { HomeCopyVariant } from './home-copy.entity.js';
import { DESTINATION_CATALOG, HOME_CONFIG, HOME_COPY_REFRESH_CRON, HOME_COPY_REFRESH_JOB, HOME_COPY_TTL_MS, HOME_COPY_VARIANTS } from './home.types.js';
import type { BannerTier } from './home.types.js';

const LANGUAGE: Record<Locale, string> = { en: 'English', 'pt-BR': 'Brazilian Portuguese', es: 'neutral Latin American Spanish' };
const TIER_BRIEF: Record<BannerTier, string> = {
  nearby: 'a short trip in the next 15 days, close to home',
  longWeekend: 'a 3-4 day long weekend around a public holiday',
  bigTrip: 'a big trip planned 3 to 12 months ahead',
  trending: 'a destination many travelers are planning right now',
};
const ANGLE_BRIEF: Record<string, string> = {
  family: 'the whole family travelling together, every age included',
  business: 'a few days around work meetings, with a free weekend',
  explorer: 'a route through two or three places in one country or region',
};
const CALL_TIMEOUT_MS = 30_000;

export type RefreshResult = { calls: number; stored: number; skipped: number };

/**
 * The optional nightly AI copy refresh (`HOME_COPY_AI_REFRESH`): for every (destination, tier,
 * locale, angle) banners served in the last day, asks the LLM for three fresh headline/subline
 * pairs, keeps the ones that pass the copy rules and stores them in `home_copy` for 7 days. Shared
 * by all users; at most `HOME_COPY_AI_MAX_PER_NIGHT` calls a night. Logs carry counts only.
 */
@Injectable()
export class CopyRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CopyRefreshService.name);
  private running = false;
  /** Tests override this. */
  now: () => Date = () => new Date();

  constructor(
    @Inject(HOME_CONFIG) private readonly config: HomeConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    @InjectRepository(HomeCopy) private readonly store: Repository<HomeCopy>,
    @Inject(DESTINATION_CATALOG) private readonly catalog: DestinationCatalog,
    private readonly banners: BannersService,
    private readonly registry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    if (!this.config.copyAiRefresh) return;
    const job = CronJob.from({ cronTime: HOME_COPY_REFRESH_CRON, timeZone: 'UTC', onTick: () => void this.tick() });
    this.registry.addCronJob(HOME_COPY_REFRESH_JOB, job);
    job.start();
    this.logger.log(`Home copy refresh scheduled with "${HOME_COPY_REFRESH_CRON}" (UTC), at most ${this.config.copyAiMaxPerNight} calls a night`);
  }

  onModuleDestroy(): void {
    if (!this.config.copyAiRefresh) return;
    try {
      this.registry.deleteCronJob(HOME_COPY_REFRESH_JOB);
    } catch {
      // Not registered (startup failed earlier): nothing to stop.
    }
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { calls, stored, skipped } = await this.run();
      this.logger.log(`Home copy refresh: ${calls} call(s), ${stored} stored, ${skipped} skipped`);
    } catch (error) {
      this.logger.error(`Home copy refresh failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One refresh pass (no-op when the feature is off). */
  async run(): Promise<RefreshResult> {
    const result: RefreshResult = { calls: 0, stored: 0, skipped: 0 };
    if (!this.config.copyAiRefresh) return result;
    const now = this.now();
    for (const item of this.banners.recentlyServed()) {
      if (result.calls >= this.config.copyAiMaxPerNight) break;
      const destination = this.catalog.get(item.destinationId);
      if (!destination) continue;
      const existing = await this.store.findOne({ where: { destinationId: item.destinationId, tier: item.tier, locale: item.locale, angle: item.angle } });
      if (existing && existing.expiresAt.getTime() > now.getTime()) {
        result.skipped += 1;
        continue;
      }
      result.calls += 1;
      const variants = await this.generate(destination.names[item.locale], destination.country, item.tier, item.locale, item.angle);
      if (variants.length === 0) continue;
      const row = existing ?? this.store.create({ destinationId: item.destinationId, tier: item.tier, locale: item.locale, angle: item.angle });
      row.variants = variants;
      row.model = this.llm.name;
      row.expiresAt = new Date(now.getTime() + HOME_COPY_TTL_MS);
      await this.store.save(row);
      result.stored += 1;
    }
    return result;
  }

  /** The valid pairs the model returns (within the copy rules), or [] on a provider failure or bad output. */
  private async generate(name: string, country: string, tier: BannerTier, locale: Locale, angle: string): Promise<HomeCopyVariant[]> {
    const system = [
      `You write banner copy for a travel app, in ${LANGUAGE[locale]}.`,
      `Rules: the headline has at most 6 words, sentence case, names the place and a specific moment; the subline has at most 14 words and gives one concrete reason.`,
      `Second person, present tense. No exclamation marks, no emoji, no "amazing" or "incredible", no urgency ("only today"), no invented numbers.`,
      `Return exactly ${HOME_COPY_VARIANTS} different variants.`,
    ].join('\n');
    const user = [
      `${HOME_COPY_DESTINATION_PREFIX}${name}`,
      `Country: ${countryName(country, locale)}`,
      `Banner: ${TIER_BRIEF[tier]}${angle && ANGLE_BRIEF[angle] ? `; angle: ${ANGLE_BRIEF[angle]}` : ''}`,
    ].join('\n');
    try {
      const { json } = await this.llm.draftTurn({ system, history: [{ role: 'user', text: user }], schema: HOME_COPY_SCHEMA, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const list = (json as { variants?: unknown })?.variants;
      if (!Array.isArray(list)) return [];
      return list
        .filter((v): v is HomeCopyVariant => typeof v === 'object' && v !== null && typeof (v as HomeCopyVariant).headline === 'string' && typeof (v as HomeCopyVariant).subline === 'string')
        .map((v) => ({ headline: v.headline.trim(), subline: v.subline.trim() }))
        .filter((v) => copyProblems(v).length === 0)
        .slice(0, HOME_COPY_VARIANTS);
    } catch (error) {
      const reason = error instanceof AiUnavailableError ? error.reason : (error as Error).name;
      this.logger.warn(`Home copy refresh: ${tier}/${locale} generation failed (${reason})`);
      return [];
    }
  }
}
