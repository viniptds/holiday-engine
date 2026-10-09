/** TEST ONLY: a recording push provider and mail transport. */
import type { MailMessage, MailTransport } from '../../mail/mail.types.js';
import type { PushMessage, PushProvider, PushReceipt, PushTicketResult } from '../push/push-provider.js';

export class FakePush implements PushProvider {
  readonly name = 'expo' as const;
  sent: PushMessage[] = [];
  /** Tokens Expo refuses at send time with this error. */
  refuse = new Map<string, string>();
  /** Receipts to answer, by ticket id. */
  receiptsById = new Map<string, PushReceipt>();
  private next = 0;

  async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
    this.sent.push(...messages);
    return messages.map((m) => (this.refuse.has(m.to) ? { token: m.to, error: this.refuse.get(m.to) } : { token: m.to, ticketId: `ticket-${++this.next}` }));
  }

  async receipts(ids: string[]): Promise<Map<string, PushReceipt>> {
    return new Map(ids.filter((id) => this.receiptsById.has(id)).map((id) => [id, this.receiptsById.get(id)!]));
  }

  /** Bodies pushed to `token`, other than achievements (unless asked for). */
  to(token: string, type?: string): string[] {
    return this.sent.filter((m) => m.to === token && (type ? m.data.type === type : m.data.type !== 'achievement')).map((m) => m.body);
  }

  reset() {
    this.sent = [];
    this.refuse.clear();
    this.receiptsById.clear();
  }
}

export class FakeMail implements MailTransport {
  readonly provider = 'fake';
  sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<{ id?: string }> {
    this.sent.push(message);
    return { id: `mail-${this.sent.length}` };
  }
}

/** An Expo-shaped push token. */
export const expoToken = (label: string) => `ExponentPushToken[${label}]`;
