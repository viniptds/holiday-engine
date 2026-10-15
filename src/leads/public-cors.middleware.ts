import { Inject, Injectable } from '@nestjs/common';
import type { NestMiddleware } from '@nestjs/common';
import { allowedOrigin, LEADS_CONFIG } from './leads.config.js';
import type { LeadsConfig } from './leads.config.js';

type HttpRequest = { method: string; headers: Record<string, string | string[] | undefined> };
type HttpResponse = { setHeader(name: string, value: string): unknown; vary?(field: string): unknown; status(code: number): { end(): void } };

/**
 * CORS for `/public/v1/*` only, from `WEB_ORIGINS` only: the matched origin is echoed (never `*`),
 * `Vary: Origin` always, preflight answered here (204) with GET/POST and Content-Type. An origin
 * that isn't allowed gets no CORS headers, so the browser blocks the call.
 */
@Injectable()
export class PublicCorsMiddleware implements NestMiddleware {
  constructor(@Inject(LEADS_CONFIG) private readonly config: LeadsConfig) {}

  use(request: HttpRequest, response: HttpResponse, next: () => void): void {
    const origin = request.headers.origin;
    response.setHeader('Vary', 'Origin');
    const matched = allowedOrigin(this.config, typeof origin === 'string' ? origin : undefined, undefined);
    if (matched) response.setHeader('Access-Control-Allow-Origin', matched);
    if (request.method === 'OPTIONS') {
      if (matched) {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Max-Age', '600');
      }
      response.status(204).end();
      return;
    }
    next();
  }
}
