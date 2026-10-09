/** One push message to one device token. `data` carries the deep link. */
export type PushMessage = { to: string; title: string; body: string; data: Record<string, unknown> };
/** Per message, in order: accepted (with a ticket id to check later) or refused (Expo's error code). */
export type PushTicketResult = { token: string; ticketId?: string; error?: string };
export type PushReceipt = { status: 'ok' | 'error'; error?: string };

export interface PushProvider {
  readonly name: 'expo' | 'log';
  send(messages: PushMessage[]): Promise<PushTicketResult[]>;
  /** Receipts by ticket id (missing ids aren't ready yet or expired). */
  receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
