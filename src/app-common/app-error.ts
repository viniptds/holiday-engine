import { HttpStatus } from '@nestjs/common';

/** Error codes of the app API (`docs/app-api-contract.md`). */
export type AppErrorCode =
  | 'VALIDATION'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'PAYMENT_REQUIRED'
  | 'AI_UNAVAILABLE'
  | 'BILLING_UNAVAILABLE'
  | 'INTERNAL';

export const APP_ERROR_STATUS: Record<AppErrorCode, HttpStatus> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  PAYMENT_REQUIRED: HttpStatus.PAYMENT_REQUIRED,
  AI_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  BILLING_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
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
  'UNASSIGNED_MOMENTS_LIMIT',
  'UPLOAD_INCOMPLETE',
  'UPLOAD_MISMATCH',
  'MOMENT_DAY_LOCKED',
  'CHECKLIST_FULL',
  'NO_GOOGLE_PICTURE',
  'REQUEST_IN_PROGRESS',
] as const;
export const FORBIDDEN_REASONS = ['REMOVED_FROM_TRIP', 'INVITE_OTHER_ACCOUNT', 'DEV_ACCOUNT_EMAIL_INVITE', 'NOT_CONVERSATION_AUTHOR'] as const;
/** VALIDATION carries a reason only where the contract lists one. */
export const VALIDATION_REASONS = ['STEP_NOT_SKIPPABLE'] as const;
export const PAYMENT_REQUIRED_REASONS = ['AI_QUOTA_EXCEEDED', 'TRIP_PLACES_PLUS_REQUIRED', 'MOMENTS_PLUS_REQUIRED'] as const;
export type AppErrorReason =
  | (typeof CONFLICT_REASONS)[number]
  | (typeof FORBIDDEN_REASONS)[number]
  | (typeof PAYMENT_REQUIRED_REASONS)[number]
  | (typeof VALIDATION_REASONS)[number];

/** Body of every app API error response. Some errors add documented top-level extras (`resetsAt`, `limit`). */
export type AppErrorBody = {
  code: AppErrorCode;
  message: string;
  reason?: AppErrorReason;
  fields?: Record<string, string>;
  [extra: string]: unknown;
};

/** Extra details for an error. */
export type AppErrorOptions = {
  /** Sent as the `Retry-After` header (whole seconds), e.g. with RATE_LIMITED. */
  retryAfterSeconds?: number;
  /** Sent as `reason` in the body. */
  reason?: AppErrorReason;
  /** Extra top-level body fields the contract documents for this error (e.g. `resetsAt`, `limit`). */
  extra?: Record<string, string | number>;
  /** An HTTP status other than the code's usual one, where the contract says so (an Idempotency-Key reused elsewhere → 422 VALIDATION). */
  status?: number;
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

/** PAYMENT_REQUIRED (402) with its contract reason and body extras. */
export const paymentRequired = (
  reason: (typeof PAYMENT_REQUIRED_REASONS)[number],
  message: string,
  extra: Record<string, string | number>,
) => new AppError('PAYMENT_REQUIRED', message, undefined, { reason, extra });

/** FORBIDDEN with its contract reason. */
export const forbidden = (reason: (typeof FORBIDDEN_REASONS)[number], message: string) =>
  new AppError('FORBIDDEN', message, undefined, { reason });
