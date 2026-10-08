import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { StorageRequestContext } from './storage/object-storage.js';

type RequestLike = { protocol?: string; headers: Record<string, string | string[] | undefined> };

/** The engine's own origin for this request (`http://localhost:3001`), for signed `/files` URLs. */
export function storageContext(request: RequestLike): StorageRequestContext {
  const header = request.headers.host;
  const host = (Array.isArray(header) ? header[0] : header) ?? 'localhost';
  // Hosts are [A-Za-z0-9.-] with an optional port (or a bracketed IPv6 literal); anything else is ignored.
  const safeHost = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host) ? host : 'localhost';
  return { baseUrl: `${request.protocol === 'https' ? 'https' : 'http'}://${safeHost}` };
}

/** `@Storage()`: the request's `StorageRequestContext`. */
export const StorageContext = createParamDecorator((_data: unknown, context: ExecutionContext): StorageRequestContext =>
  storageContext(context.switchToHttp().getRequest<RequestLike>()),
);
