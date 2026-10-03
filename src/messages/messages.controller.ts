import { Body, Controller, HttpCode, Post, ValidationPipe } from '@nestjs/common';
import { MessagesService } from './messages.service.js';
import { InboundEnvelopeDto } from './dto/inbound-envelope.dto.js';

/** Rejects a malformed envelope with 400. Payloads are checked later, per type, by the router. */
export const envelopePipe = new ValidationPipe({ transform: true });

@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post('post-message')
  @HttpCode(202)
  async postMessage(@Body(envelopePipe) body: InboundEnvelopeDto) {
    const jobId = await this.messages.enqueue(body);
    return { jobId };
  }
}
