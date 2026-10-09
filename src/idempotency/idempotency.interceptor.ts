import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Interval } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { LessThan, Repository } from 'typeorm';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { AppError, conflict } from '../app-common/app-error.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { IdempotencyKey } from './idempotency-key.entity.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

type Request = { method: string; originalUrl?: string; url: string; headers: Record<string, string | string[] | undefined>; user?: AuthUser };

const isUniqueViolation = (error: unknown) =>
  (error as { code?: string })?.code === '23505' || (error as { driverError?: { code?: string } })?.driverError?.code === '23505';

/** The `idempotency_keys` table, shared by every module using the interceptor; prunes it hourly. */
@Injectable()
export class IdempotencyStore {
  private readonly logger = new Logger(IdempotencyStore.name);

  constructor(@InjectRepository(IdempotencyKey) readonly keys: Repository<IdempotencyKey>) {}

  /** Hourly: keys older than 24 h. */
  @Interval('idempotency-keys-cleanup', 60 * 60 * 1000)
  async cleanup(now = new Date()): Promise<void> {
    try {
      await this.keys.delete({ createdAt: LessThan(new Date(now.getTime() - IDEMPOTENCY_TTL_MS)) });
    } catch (error) {
      this.logger.warn(`Idempotency keys cleanup failed: ${(error as Error).message}`);
    }
  }
}

/**
 * `Idempotency-Key` (a UUID) on the writes the app's offline queue replays: the first successful
 * response is stored for 24 h per user and key, and a replay returns it without a second write.
 * The same key on another method or path → 422 VALIDATION; while the first is still running →
 * 409 REQUEST_IN_PROGRESS. Failed requests aren't stored, so they can be retried with the same key.
 * Without the header, nothing changes. Runs after the auth guard (it needs the user).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly keys: Repository<IdempotencyKey>;

  // Instantiated in each controller's module: it depends on the exported store, not on a repository.
  constructor(store: IdempotencyStore) {
    this.keys = store.keys;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[IDEMPOTENCY_HEADER];
    const raw = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!raw || !request.user) return next.handle();
    if (!isUUID(raw)) throw new AppError('VALIDATION', 'Some fields are invalid', { 'Idempotency-Key': 'must be a UUID' });

    const key = raw.toLowerCase();
    const userId = request.user.id;
    const method = request.method.toUpperCase();
    const path = (request.originalUrl ?? request.url).split('?')[0];
    const now = Date.now();
    // What Nest will answer: the route's @HttpCode, else 201 for POST and 200 otherwise.
    const status = (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as number | undefined) ?? (method === 'POST' ? 201 : 200);

    const existing = await this.keys.findOne({ where: { userId, key } });
    if (existing && new Date(existing.createdAt).getTime() > now - IDEMPOTENCY_TTL_MS) {
      if (existing.method !== method || existing.path !== path) {
        throw new AppError('VALIDATION', 'This Idempotency-Key was already used for another request', { 'Idempotency-Key': 'already used for another request' }, { status: 422 });
      }
      if (existing.status === 0) throw conflict('REQUEST_IN_PROGRESS', 'The first request with this Idempotency-Key is still being processed');
      // The route's own status code (@HttpCode) is applied when Nest sends the replayed body.
      return of(existing.responseBody ?? undefined);
    }
    if (existing) await this.keys.delete({ userId, key });
    try {
      await this.keys.insert({ userId, key, method, path, status: 0, responseBody: null } as never);
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('REQUEST_IN_PROGRESS', 'The first request with this Idempotency-Key is still being processed');
      throw error;
    }

    return next.handle().pipe(
      mergeMap((body) =>
        from(
          this.keys
            .update({ userId, key }, { status, responseBody: body === undefined || body === null ? null : (JSON.parse(JSON.stringify(body)) as object) } as never)
            .then(() => body),
        ),
      ),
      catchError((error: unknown) =>
        from(this.keys.delete({ userId, key }).catch(() => undefined)).pipe(
          mergeMap(() => {
            throw error;
          }),
        ),
      ),
    );
  }
}
