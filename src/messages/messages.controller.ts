import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { MessagesService } from './messages.service.js';

@Controller()
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Post('post-message')
  @HttpCode(202)
  async postMessage(@Body() body: Record<string, unknown>) {
    const jobId = await this.messages.enqueue(body);
    return { jobId };
  }
}
