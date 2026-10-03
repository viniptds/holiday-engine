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

/** Body of every app API error response. */
export type AppErrorBody = { code: AppErrorCode; message: string; fields?: Record<string, string> };

/** Extra HTTP response details for an error. */
export type AppErrorOptions = {
  /** Sent as the `Retry-After` header (whole seconds), e.g. with RATE_LIMITED. */
  retryAfterSeconds?: number;
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
}
