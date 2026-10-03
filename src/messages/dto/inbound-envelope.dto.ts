import { IsIn, IsNotEmpty, IsObject, IsString, IsUUID } from 'class-validator';
import { INBOUND_TYPES, PROVIDERS } from '../messages.constants.js';
import type { InboundType } from '../messages.constants.js';

/** `POST /post-message` body. The payload is validated later, by the router, per `type`. */
export class InboundEnvelopeDto {
  @IsIn(INBOUND_TYPES)
  type: InboundType;

  @IsIn(PROVIDERS)
  provider: string;

  // String, not number: Telegram ids can exceed 2^31.
  @IsString()
  @IsNotEmpty()
  chatId: string;

  @IsUUID()
  correlationId: string;

  @IsObject()
  payload: Record<string, unknown>;
}
