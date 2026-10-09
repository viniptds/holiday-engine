import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { ChecklistService } from './checklist.service.js';
import type { ChecklistItemDto, ReminderDto, SuggestionDto } from './checklist.service.js';
import { BulkChecklistDto, ChecklistOrderDto, ChecklistReminderDto, CreateChecklistItemDto, PatchChecklistItemDto } from './checklist.dto.js';

/** A trip's checklist (docs/app-notifications-checklist-calendar-spec.md). Static routes come before `:itemId`. */
@Controller(`${APP_PREFIX}/trips/:tripId/checklist`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class ChecklistController {
  constructor(private readonly checklist: ChecklistService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string): Promise<{ items: ChecklistItemDto[]; myReminders: ReminderDto[] }> {
    return this.checklist.list(user, tripId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Body(appValidationPipe) body: CreateChecklistItemDto): Promise<ChecklistItemDto> {
    return this.checklist.create(user, tripId, body);
  }

  @Put('order')
  async order(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Body(appValidationPipe) body: ChecklistOrderDto): Promise<{ items: ChecklistItemDto[] }> {
    return { items: await this.checklist.order(user, tripId, body.itemIds) };
  }

  @Post('bulk')
  @HttpCode(HttpStatus.CREATED)
  async bulk(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Body(appValidationPipe) body: BulkChecklistDto): Promise<{ items: ChecklistItemDto[] }> {
    return { items: await this.checklist.bulk(user, tripId, body.items) };
  }

  @Post('suggestions')
  @HttpCode(HttpStatus.OK)
  async suggestions(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @RequestLocale() locale: Locale): Promise<{ items: SuggestionDto[] }> {
    return { items: await this.checklist.suggest(user, tripId, locale) };
  }

  @Patch(':itemId')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Param('itemId') itemId: string,
    @Body(appValidationPipe) body: PatchChecklistItemDto,
  ): Promise<ChecklistItemDto> {
    return this.checklist.patch(user, tripId, itemId, body);
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Param('itemId') itemId: string): Promise<void> {
    await this.checklist.delete(user, tripId, itemId);
  }

  @Put(':itemId/reminder')
  setReminder(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Param('itemId') itemId: string,
    @Body(appValidationPipe) body: ChecklistReminderDto,
  ): Promise<ReminderDto> {
    return this.checklist.setReminder(user, tripId, itemId, body.remindAt);
  }

  @Delete(':itemId/reminder')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeReminder(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Param('itemId') itemId: string): Promise<void> {
    await this.checklist.removeReminder(user, tripId, itemId);
  }
}
