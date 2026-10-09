import type { PushMessage, PushProvider, PushReceipt, PushTicketResult } from './push-provider.js';

export const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';
export const EXPO_SEND_BATCH = 100;
export const EXPO_RECEIPTS_BATCH = 1000;
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
type ExpoTicket = { status?: string; id?: string; message?: string; details?: { error?: string } };

/**
 * PUSH_PROVIDER=expo: Expo's push service over fetch (no SDK), in batches of 100, with
 * `Authorization: Bearer EXPO_ACCESS_TOKEN` when it's set (push security). Errors carry the HTTP
 * status only; tokens are never logged.
 */
export class ExpoPushProvider implements PushProvider {
  readonly name = 'expo' as const;

  constructor(
    private readonly accessToken: string | undefined,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {}

  async send(messages: PushMessage[]): Promise<PushTicketResult[]> {
    const results: PushTicketResult[] = [];
    for (let i = 0; i < messages.length; i += EXPO_SEND_BATCH) {
      const batch = messages.slice(i, i + EXPO_SEND_BATCH);
      const body = (await this.post(EXPO_SEND_URL, batch.map((m) => ({ ...m, sound: 'default', priority: 'high' })))) as { data?: ExpoTicket[] };
      batch.forEach((message, index) => {
        const ticket = body.data?.[index];
        if (ticket?.status === 'ok' && ticket.id) results.push({ token: message.to, ticketId: ticket.id });
        else results.push({ token: message.to, error: ticket?.details?.error ?? 'Unknown' });
      });
    }
    return results;
  }

  async receipts(ticketIds: string[]): Promise<Map<string, PushReceipt>> {
    const receipts = new Map<string, PushReceipt>();
    for (let i = 0; i < ticketIds.length; i += EXPO_RECEIPTS_BATCH) {
      const body = (await this.post(EXPO_RECEIPTS_URL, { ids: ticketIds.slice(i, i + EXPO_RECEIPTS_BATCH) })) as {
        data?: Record<string, { status?: string; details?: { error?: string } }>;
      };
      for (const [id, receipt] of Object.entries(body.data ?? {})) {
        receipts.set(id, receipt.status === 'ok' ? { status: 'ok' } : { status: 'error', error: receipt.details?.error ?? 'Unknown' });
      }
    }
    return receipts;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
        'content-type': 'application/json',
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Expo push failed: HTTP ${response.status}`);
    return response.json();
  }
}
