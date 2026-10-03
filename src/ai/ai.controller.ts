import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Res, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestLocale } from '../app-common/locale.js';
import type { Locale } from '../app-common/locale.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { AiService, FirstTurnUnavailableError } from './ai.service.js';
import type { AiConversationDto, AiTurnDto, TripPlaceDto } from './ai.types.js';
import { ConfirmAiConversationDto, PostAiMessageDto, StartAiConversationDto } from './dto/ai-message.dto.js';

// Minimal shape of the Express response (no @types/express in this project).
type StatusResponse = { status(code: number): unknown };

/** AI trip planning (`docs/app-ai-spec.md`). Conversations are visible to their author only. */
@Controller(`${APP_PREFIX}/ai/conversations`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class AiConversationsController {
  constructor(private readonly ai: AiService) {}

  /** `201`. If the first turn fails, `503 { code: 'AI_UNAVAILABLE', message, conversationId }` to retry in. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async start(
    @CurrentUser() user: AuthUser,
    @RequestLocale() locale: Locale,
    @Body(appValidationPipe) body: StartAiConversationDto,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<{ conversation: AiConversationDto; turn: AiTurnDto } | { code: string; message: string; conversationId: string }> {
    try {
      return await this.ai.start(user, locale, body);
    } catch (error) {
      if (!(error instanceof FirstTurnUnavailableError)) throw error;
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { code: error.code, message: error.message, conversationId: error.conversationId };
    }
  }

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<{ conversations: AiConversationDto[] }> {
    return { conversations: await this.ai.list(user) };
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ conversation: AiConversationDto; turns: AiTurnDto[] }> {
    return this.ai.get(user, id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  async post(
    @CurrentUser() user: AuthUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(appValidationPipe) body: PostAiMessageDto,
  ): Promise<{ turn: AiTurnDto }> {
    return { turn: await this.ai.post(user, locale, id, body.message) };
  }

  /** `201` with the new trip, or `200` with the linked (or already confirmed) trip. */
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(appValidationPipe) _body: ConfirmAiConversationDto,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<AppTripDto> {
    const { trip, created } = await this.ai.confirm(user, id);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return trip;
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abandon(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.ai.abandon(user, id);
  }
}

/** Places saved on a trip: members read them, owners and editors remove them. */
@Controller(`${APP_PREFIX}/trips/:tripId/places`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class TripPlacesController {
  constructor(private readonly ai: AiService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string): Promise<{ places: TripPlaceDto[] }> {
    return { places: await this.ai.listPlaces(user, tripId) };
  }

  @Delete(':placeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Param('placeId') placeId: string): Promise<void> {
    await this.ai.deletePlace(user, tripId, placeId);
  }
}
