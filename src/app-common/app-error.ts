import { HttpStatus } from '@nestjs/common';

/** Error codes of the app API (`docs/app-api-contract.md`). */
export type AppErrorCode = 'VALIDATION' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL';

export const APP_ERROR_STATUS: Record<AppErrorCode, HttpStatus> = {
  VALIDATION: HttpStatus.BAD_REQUEST,
  UNAUTHENTICATED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Body of every app API error response. */
export type AppErrorBody = { code: AppErrorCode; message: string; fields?: Record<string, string> };

/** Throw from app API code; `AppExceptionFilter` turns it into the contract's error response. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
