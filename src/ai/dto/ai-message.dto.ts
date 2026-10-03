import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';
import { Trim } from '../../trips/dto/trim.transform.js';
import { MAX_MESSAGE_LENGTH } from '../ai.types.js';

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

/** `POST /ai/conversations/:id/confirm` body: `{}`. */
export class ConfirmAiConversationDto {}
