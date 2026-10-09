import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Res, UseFilters, UseGuards, Headers } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { matchLocale, resolveLocale } from '../app-common/locale.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { renderUnsubscribePage } from '../mail/templates/countdown.js';
import { NotificationsService } from './notifications.service.js';
import type { NotificationDto } from './notifications.service.js';
import { MarkReadDto, NotificationsQueryDto, PushTokenDto } from './notifications.dto.js';
import type { NotificationPrefs } from './notification-prefs.js';

/** Push tokens, notification settings and the inbox (docs/app-notifications-checklist-calendar-spec.md). */
@Controller(`${APP_PREFIX}/me`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class MyNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('push-tokens')
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: PushTokenDto): Promise<void> {
    await this.notifications.registerToken(user, body.token, body.platform, body.deviceId ?? null);
  }

  @Delete('push-tokens/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentUser() user: AuthUser, @Param('token') token: string): Promise<void> {
    await this.notifications.removeToken(user, token);
  }

  @Get('notification-settings')
  settings(@CurrentUser() user: AuthUser): Promise<NotificationPrefs> {
    return this.notifications.settings(user.id);
  }

  @Patch('notification-settings')
  update(@CurrentUser() user: AuthUser, @Body() body: unknown): Promise<NotificationPrefs> {
    return this.notifications.updateSettings(user, body);
  }

  @Get('notifications')
  list(@CurrentUser() user: AuthUser, @Query(appValidationPipe) query: NotificationsQueryDto): Promise<{ notifications: NotificationDto[]; nextCursor: string | null }> {
    return this.notifications.list(user, query.before);
  }

  @Post('notifications/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  async read(@CurrentUser() user: AuthUser, @Body(appValidationPipe) body: MarkReadDto): Promise<void> {
    await this.notifications.markRead(user, body);
  }
}

/** `GET /email/unsubscribe?token=`: from an email link, no sign-in; answers a small localized page. */
@Controller(`${APP_PREFIX}/email`)
export class EmailUnsubscribeController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('unsubscribe')
  async unsubscribe(@Query('token') token: string, @Headers('accept-language') language: string | undefined, @Res() response: ServerResponse): Promise<void> {
    const result = await this.notifications.unsubscribeEmail(typeof token === 'string' ? token : '');
    const locale = (language ? matchLocale(resolveLocale(language)) : null) ?? result.locale ?? 'en';
    response.writeHead(result.ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(renderUnsubscribePage(locale, result.ok));
  }
}
