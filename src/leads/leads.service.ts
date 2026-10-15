import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError } from 'typeorm';
import type { Repository } from 'typeorm';
import { AppError, conflict, forbidden } from '../app-common/app-error.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RateWindow } from '../app-common/rate-window.js';
import { User } from '../users/user.entity.js';
import { CreateLeadDto } from './leads.dto.js';
import { Lead } from './lead.entity.js';
import type { LeadStatus, LeadUtm } from './lead.entity.js';
import { allowedOrigin, LEADS_CONFIG } from './leads.config.js';
import type { LeadsConfig } from './leads.config.js';
import { LeadsTokenService } from './leads-token.service.js';

export type RequestInfo = { origin?: string; referer?: string; userAgent?: string; ip?: string };
export type LeadResult = { status: 200 | 201; body: { id: string; status: LeadStatus } };

const USER_AGENT_MAX = 300;
const HOUR_MS = 3_600_000;
const isUniqueViolation = (error: unknown) =>
  error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === '23505';

/** Lead capture (docs/web-leads-spec.md): the checks in their documented order, then the uniqueness rules. No external calls. */
@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  /** Per IP, in memory (per process). */
  readonly tokenLimit = new RateWindow(30, HOUR_MS, 'Too many form tokens requested');
  readonly hourLimit = new RateWindow(5, HOUR_MS, 'Too many submissions from this network');
  readonly dayLimit = new RateWindow(20, 24 * HOUR_MS, 'Too many submissions from this network');

  constructor(
    @InjectRepository(Lead) private readonly leads: Repository<Lead>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @Inject(LEADS_CONFIG) private readonly config: LeadsConfig,
    private readonly tokens: LeadsTokenService,
  ) {}

  /** `GET /leads/token`. */
  issueToken(request: RequestInfo): { token: string; expiresInSeconds: number } {
    const origin = this.requireOrigin(request);
    this.tokenLimit.take(request.ip ?? 'unknown');
    return this.tokens.issue(origin);
  }

  /** `POST /leads`: origin, token, honeypot, validation, rate limits, uniqueness. */
  async submit(rawBody: unknown, request: RequestInfo): Promise<LeadResult> {
    const origin = this.requireOrigin(request);
    const raw: Record<string, unknown> = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
    if (!this.tokens.redeem(raw.token, origin)) throw forbidden('FORM_TOKEN_INVALID', 'The form token is invalid, expired or already used');

    // Honeypot: look like a success, store nothing.
    if (typeof raw.website === 'string' && raw.website.trim() !== '') return { status: 201, body: { id: randomUUID(), status: 'new' } };

    const dto = (await appValidationPipe.transform(raw, { type: 'body', metatype: CreateLeadDto })) as CreateLeadDto;

    const ip = request.ip ?? 'unknown';
    this.hourLimit.assertRoom(ip);
    this.dayLimit.assertRoom(ip);
    this.hourLimit.take(ip);
    this.dayLimit.take(ip);

    const email = dto.email.trim().toLowerCase();
    const existing = await this.leads.findOne({ where: { email } });
    if (existing) {
      if (dto.kind === 'contact' && dto.message && existing.kind === 'beta') {
        existing.message = dto.message;
        if (dto.role) existing.role = dto.role;
        await this.leads.save(existing);
        this.logger.log(`Lead ${existing.id} updated with a contact message`);
        return { status: 200, body: { id: existing.id, status: existing.status } };
      }
      throw conflict('EMAIL_ALREADY_REGISTERED', 'This email is already on the list');
    }
    if (await this.users.findOne({ where: { email } })) throw conflict('EMAIL_HAS_ACCOUNT', 'This email already has an account');

    try {
      const saved = await this.leads.save(
        this.leads.create({
          email,
          name: dto.name ?? null,
          kind: dto.kind,
          role: dto.role ?? null,
          message: dto.kind === 'contact' ? (dto.message ?? null) : null,
          lang: dto.lang,
          source: dto.source,
          utm: cleanUtm(dto.utm),
          ipHash: createHash('sha256').update(`${request.ip ?? ''}${this.config.hashSalt}`).digest('hex'),
          userAgent: request.userAgent ? request.userAgent.slice(0, USER_AGENT_MAX) : null,
          status: 'new',
          convertedUserId: null,
        }),
      );
      this.logger.log(`Lead ${saved.id} created (${dto.kind}, ${dto.source})`);
      return { status: 201, body: { id: saved.id, status: saved.status } };
    } catch (error) {
      // A concurrent submission of the same email won the unique index.
      if (isUniqueViolation(error)) throw conflict('EMAIL_ALREADY_REGISTERED', 'This email is already on the list');
      throw error;
    }
  }

  /** Marks the lead with this email `converted` (sign-in hook; the caller treats failures as non-fatal). */
  async convert(user: { id: string; email: string }): Promise<void> {
    await this.leads.update(
      { email: user.email.trim().toLowerCase(), status: In<LeadStatus>(['new', 'invited', 'unsubscribed']) },
      { status: 'converted', convertedUserId: user.id },
    );
  }

  private requireOrigin(request: RequestInfo): string {
    const origin = allowedOrigin(this.config, request.origin, request.referer);
    if (!origin) throw forbidden('ORIGIN_NOT_ALLOWED', 'This origin may not use the public API');
    return origin;
  }
}

function cleanUtm(utm: CreateLeadDto['utm']): LeadUtm | null {
  if (!utm) return null;
  const entries = Object.entries(utm).filter(([, value]) => typeof value === 'string' && value !== '');
  return entries.length ? (Object.fromEntries(entries) as LeadUtm) : null;
}
