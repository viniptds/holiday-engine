import { Logger } from '@nestjs/common';
import type { PushMessage, PushProvider, PushReceipt, PushTicketResult } from './push-provider.js';

/** PUSH_PROVIDER=log (default, dev only; refused in production): sends nothing, logs the type and recipient count, never tokens. */
export class LogPushProvider implements PushProvider {
  readonly name = 'log' as const;
  private readonly logger = new Logger('Push');

  async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
    const types = [...new Set(messages.map((m) => String(m.data.type ?? 'unknown')))].join(', ');
    this.logger.log(`Not sent (PUSH_PROVIDER=log): ${types} to ${messages.length} device(s)`);
    return messages.map((m) => ({ token: m.to }));
  }

  async receipts(): Promise<Map<string, PushReceipt>> {
    return new Map();
  }
}
