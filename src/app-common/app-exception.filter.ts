import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { APP_ERROR_STATUS, AppError, AppErrorBody, AppErrorCode } from './app-error.js';

// Minimal shape of the Express response (no @types/express in this project).
type JsonResponse = { status(code: number): { json(body: unknown): void } };

const CODE_BY_STATUS: Partial<Record<number, AppErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
};

function httpExceptionMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  return typeof message === 'string' ? message : exception.message;
}

/** Converts anything thrown by app API code into `{ code, message, fields? }`. Use on app controllers only. */
export function toAppErrorBody(exception: unknown): { status: number; body: AppErrorBody } {
  if (exception instanceof AppError) {
    const body: AppErrorBody = { code: exception.code, message: exception.message };
    if (exception.fields) body.fields = exception.fields;
    return { status: APP_ERROR_STATUS[exception.code], body };
  }
  if (exception instanceof HttpException) {
    const code = CODE_BY_STATUS[exception.getStatus()];
    if (code) return { status: APP_ERROR_STATUS[code], body: { code, message: httpExceptionMessage(exception) } };
  }
  return { status: APP_ERROR_STATUS.INTERNAL, body: { code: 'INTERNAL', message: 'Something went wrong' } };
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const { status, body } = toAppErrorBody(exception);
    if (body.code === 'INTERNAL') {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }
    host.switchToHttp().getResponse<JsonResponse>().status(status).json(body);
  }
}
