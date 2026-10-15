import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Req, Res, UseFilters } from '@nestjs/common';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { PUBLIC_PREFIX } from './leads.config.js';
import { LeadsService } from './leads.service.js';
import type { RequestInfo } from './leads.service.js';

type HttpRequest = { ip?: string; headers: Record<string, string | string[] | undefined> };
type HttpResponse = { status(code: number): unknown };

const header = (request: HttpRequest, name: string) => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const info = (request: HttpRequest): RequestInfo => ({
  origin: header(request, 'origin'),
  referer: header(request, 'referer'),
  userAgent: header(request, 'user-agent'),
  ip: request.ip,
});

/**
 * Public lead capture (docs/web-leads-spec.md). Deliberately NOT behind AuthGuard: it is protected
 * by the origin allowlist, the single-use form token, the honeypot and per-IP rate limits.
 */
@Controller(`${PUBLIC_PREFIX}/leads`)
@UseFilters(AppExceptionFilter)
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  @Get('token')
  token(@Req() request: HttpRequest) {
    return this.leads.issueToken(info(request));
  }

  /** The body is validated by the service, after the origin and token checks (the documented order). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() body: unknown, @Req() request: HttpRequest, @Res({ passthrough: true }) response: HttpResponse) {
    const result = await this.leads.submit(body, info(request));
    response.status(result.status);
    return result.body;
  }
}
