import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Res, UseFilters, UseGuards } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import type { AuthUser } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { RequestLocale } from '../app-common/locale.js';
import { RequestTimezone } from '../app-common/timezone.js';
import type { Locale } from '../app-common/locale.js';
import { AuthGuard } from '../auth/auth.guard.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AppTripDto } from '../app-trips/app-trips.types.js';
import { AiService, FirstTurnUnavailableError } from './ai.service.js';
import type { AiConversationDto, AiTurnDto, ItineraryDto, PlaceSearchResultDto, TripAiConversationDto, TripPlaceDto } from './ai.types.js';
import { ItineraryService } from './itinerary.service.js';
import { AddPlaceDto, PatchPlaceDto, PutItineraryDto, SearchPlacesQueryDto } from './dto/places.dto.js';
import { ConfirmAiConversationDto, PostAiMessageDto, StartAiConversationDto } from './dto/ai-message.dto.js';

// Minimal shape of the Express response (no @types/express in this project).
type StatusResponse = { status(code: number): unknown };

/**
 * AI trip planning (`docs/app-ai-spec.md`). A conversation linked to a trip is readable by that
 * trip's members (read-only); only its author can post, confirm or abandon. Unlinked ones are private.
 */
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
    @RequestTimezone() timeZone: string,
  ): Promise<{ conversation: AiConversationDto; turn: AiTurnDto } | { code: string; message: string; conversationId: string }> {
    try {
      return await this.ai.start(user, locale, body, timeZone);
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
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ conversation: AiConversationDto; turns: AiTurnDto[]; readOnly: boolean }> {
    return this.ai.get(user, id);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.OK)
  async post(
    @CurrentUser() user: AuthUser,
    @RequestLocale() locale: Locale,
    @Param('id') id: string,
    @Body(appValidationPipe) body: PostAiMessageDto,
    @RequestTimezone() timeZone: string,
  ): Promise<{ turn: AiTurnDto }> {
    return { turn: await this.ai.post(user, locale, id, body.message, timeZone) };
  }

  /**
   * `201` with the new trip, or `200` with the linked (or already confirmed) trip; either way with
   * `added`, `skipped` (already in the trip, or past the 200 cap) and `skippedForPlan` (past the
   * trip owner's plan limit) next to the Trip's fields.
   */
  @Post(':id/confirm')
  async confirm(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(appValidationPipe) body: ConfirmAiConversationDto,
    @Res({ passthrough: true }) response: StatusResponse,
    @RequestLocale() locale: Locale,
  ): Promise<AppTripDto & { added: number; skipped: number; skippedForPlan: number }> {
    const { trip, created, added, skipped, skippedForPlan } = await this.ai.confirm(user, id, locale, body.placeIds);
    response.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return { ...trip, added, skipped, skippedForPlan };
  }

  @Post(':id/abandon')
  @HttpCode(HttpStatus.NO_CONTENT)
  async abandon(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.ai.abandon(user, id);
  }
}

/** `GET /trips/:id/ai/conversations` (members): the trip's linked conversations from every author. */
@Controller(`${APP_PREFIX}/trips/:tripId/ai/conversations`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class TripAiConversationsController {
  constructor(private readonly ai: AiService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string): Promise<{ conversations: TripAiConversationDto[] }> {
    return { conversations: await this.ai.listForTrip(user, tripId) };
  }
}

/** Places saved on a trip (docs/app-itinerary-spec.md): members read them; owners and editors change them. */
@Controller(`${APP_PREFIX}/trips/:tripId/places`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class TripPlacesController {
  constructor(private readonly itinerary: ItineraryService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string): Promise<ItineraryDto> {
    return this.itinerary.list(user, tripId);
  }

  @Get('search')
  async search(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Query(appValidationPipe) query: SearchPlacesQueryDto,
    @RequestLocale() locale: Locale,
  ): Promise<{ results: PlaceSearchResultDto[] }> {
    return { results: await this.itinerary.search(user, tripId, query.q, query.category, locale) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  add(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Body(appValidationPipe) body: AddPlaceDto,
    @RequestLocale() locale: Locale,
  ): Promise<TripPlaceDto> {
    return this.itinerary.add(user, tripId, body, locale);
  }

  @Patch(':placeId')
  patch(
    @CurrentUser() user: AuthUser,
    @Param('tripId') tripId: string,
    @Param('placeId') placeId: string,
    @Body(appValidationPipe) body: PatchPlaceDto,
  ): Promise<TripPlaceDto> {
    return this.itinerary.patch(user, tripId, placeId, body);
  }

  @Delete(':placeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async delete(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Param('placeId') placeId: string): Promise<void> {
    await this.itinerary.remove(user, tripId, placeId);
  }
}

/** `PUT /trips/:id/itinerary`: the whole ordering, with optimistic concurrency. */
@Controller(`${APP_PREFIX}/trips/:tripId/itinerary`)
@UseFilters(AppExceptionFilter)
@UseGuards(AuthGuard)
export class TripItineraryController {
  constructor(private readonly itinerary: ItineraryService) {}

  @Put()
  put(@CurrentUser() user: AuthUser, @Param('tripId') tripId: string, @Body(appValidationPipe) body: PutItineraryDto): Promise<ItineraryDto> {
    return this.itinerary.putItinerary(user, tripId, body);
  }
}
