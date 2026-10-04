import { HttpStatus } from '@nestjs/common';

/** Error codes of the app API (`docs/app-api-contract.md`). */
export type AppErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'AI_UNAVAILABLE'
  | 'INTERNAL';

export const APP_ERROR_STATUS: Record<AppErrorCode, HttpStatus> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  AI_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Machine-readable reasons (`docs/app-api-contract.md`, Errors), so clients never parse messages.
 * CONFLICT and FORBIDDEN carry one where the contract lists it.
 */
export const CONFLICT_REASONS = [
  'REPLY_IN_PROGRESS',
  'PLAN_FULL',
  'RETRY_LIMIT',
  'CONVERSATION_CLOSED',
  'DRAFT_NOT_READY',
  'ALREADY_IN_TRIP',
  'TRIP_PLACES_LIMIT',
  'STALE_ITINERARY',
  'LAST_OWNER',
  'ALREADY_MEMBER',
  'TRIP_CHANGED',
] as const;
export const FORBIDDEN_REASONS = ['REMOVED_FROM_TRIP', 'INVITE_OTHER_ACCOUNT', 'DEV_ACCOUNT_EMAIL_INVITE'] as const;
export type AppErrorReason = (typeof CONFLICT_REASONS)[number] | (typeof FORBIDDEN_REASONS)[number];

/** Body of every app API error response. */
export type AppErrorBody = { code: AppErrorCode; message: string; reason?: AppErrorReason; fields?: Record<string, string> };

/** Extra details for an error. */
export type AppErrorOptions = {
  /** Sent as the `Retry-After` header (whole seconds), e.g. with RATE_LIMITED. */
  retryAfterSeconds?: number;
  /** Sent as `reason` in the body. */
  reason?: AppErrorReason;
};

/** Throw from app API code; `AppExceptionFilter` turns it into the contract's error response. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
    readonly options: AppErrorOptions = {},
  ) {
    super(message);
    this.name = 'AppError';
  }

  get reason(): AppErrorReason | undefined {
    return this.options.reason;
  }
}

/** CONFLICT with its contract reason. */
export const conflict = (reason: (typeof CONFLICT_REASONS)[number], message: string, fields?: Record<string, string>) =>
  new AppError('CONFLICT', message, fields, { reason });

/** FORBIDDEN with its contract reason. */
export const forbidden = (reason: (typeof FORBIDDEN_REASONS)[number], message: string) =>
  new AppError('FORBIDDEN', message, undefined, { reason });
