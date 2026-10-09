import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';
import { Trim } from '../../trips/dto/trim.transform.js';
import { CONVERSATION_STATUSES, MAX_MESSAGE_LENGTH } from '../ai.types.js';
import type { ConversationStatus } from '../ai.types.js';

/** `POST /ai/conversations/:id/messages` body. Decorators run bottom-up: the type check is last. */
export class PostAiMessageDto {
  @Trim()
  @NoControlChars()
  @MaxLength(MAX_MESSAGE_LENGTH)
  @IsNotEmpty()
  @IsString()
  message: string;
}

/** `POST /ai/conversations` body. With `tripId`, the conversation adds places to that trip. */
export class StartAiConversationDto extends PostAiMessageDto {
  @IsOptional()
  @IsUUID('4')
  tripId?: string;
}

/**
 * `POST /ai/conversations/:id/confirm` body: `{}`, or `{ placeIds }` to add only those of the
 * draft's verified places (their `googlePlaceId`s). Without it, every verified place is added.
 */
export class ConfirmAiConversationDto {
  @IsOptional()
  @MaxLength(300, { each: true })
  @IsNotEmpty({ each: true })
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsArray()
  placeIds?: string[];
}

/** `GET /ai/conversations?status=` (open, confirmed or abandoned; all when omitted). */
export class ListConversationsQueryDto {
  @IsOptional()
  @IsIn(CONVERSATION_STATUSES)
  status?: ConversationStatus;
}
