import type { MailDriver, MailMessage, MailSender, MailTransport, SettingReader } from '../mail.types.js';
import { redactValues } from '../redact.js';

export const MAILJET_SEND_URL = 'https://api.mailjet.com/v3.1/send';
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;
type MailjetError = { ErrorMessage?: string; ErrorCode?: string; ErrorIdentifier?: string };
type MailjetResponse = {
  Messages?: { Status?: string; Errors?: MailjetError[]; To?: { MessageID?: number | string; MessageUUID?: string }[] }[];
  ErrorMessage?: string;
  ErrorInfo?: string;
};

/** Short summary of a Mailjet error response, without secrets or the recipient's address. */
function describeErrors(body: MailjetResponse | null, recipient: string): string {
  const messages = (body?.Messages ?? []).flatMap((m) => m.Errors ?? []).map((e) => e.ErrorMessage ?? e.ErrorCode);
  const all = [...messages, body?.ErrorMessage, body?.ErrorInfo].filter(Boolean);
  return all.length ? redactValues(all.join('; '), [[recipient, '[recipient]']]).slice(0, 500) : 'no details';
}

/**
 * MAIL_PROVIDER=mailjet: Mailjet's HTTP Send API v3.1 over the built-in fetch, with Basic auth
 * (MAILJET_API_KEY:MAILJET_API_SECRET). The first tag becomes Mailjet's CustomCampaign.
 */
export class MailjetMailTransport implements MailTransport {
  readonly provider = 'mailjet';
  private readonly authorization: string;

  constructor(
    credentials: { apiKey: string; apiSecret: string },
    private readonly sender: MailSender,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {
    this.authorization = `Basic ${Buffer.from(`${credentials.apiKey}:${credentials.apiSecret}`).toString('base64')}`;
  }

  async send(message: MailMessage, signal?: AbortSignal): Promise<{ id?: string }> {
    const replyTo = message.replyTo ?? this.sender.replyTo;
    const payload = {
      Messages: [
        {
          From: { Email: this.sender.from, Name: this.sender.fromName },
          To: [{ Email: message.to }],
          Subject: message.subject,
          TextPart: message.text,
          HTMLPart: message.html,
          ...(replyTo ? { ReplyTo: { Email: replyTo } } : {}),
          ...(message.tags?.length ? { CustomCampaign: message.tags[0] } : {}),
        },
      ],
    };
    const response = await this.fetchFn(MAILJET_SEND_URL, {
      method: 'POST',
      headers: { authorization: this.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // The caller's signal cancels the HTTP request itself.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as MailjetResponse | null;
    if (!response.ok) {
      throw new Error(`Mailjet send failed with HTTP ${response.status}: ${describeErrors(body, message.to)}`);
    }
    const [result] = body?.Messages ?? [];
    if (result?.Status !== 'success') {
      throw new Error(`Mailjet did not accept the message (status ${result?.Status ?? 'unknown'}): ${describeErrors(body, message.to)}`);
    }
    const id = result.To?.[0]?.MessageID ?? result.To?.[0]?.MessageUUID;
    return id === undefined ? {} : { id: String(id) };
  }
}

export const mailjetDriver: MailDriver = {
  required: ['MAILJET_API_KEY', 'MAILJET_API_SECRET'],
  needsFrom: true,
  create: (setting: SettingReader, sender) =>
    new MailjetMailTransport({ apiKey: setting('MAILJET_API_KEY')!.trim(), apiSecret: setting('MAILJET_API_SECRET')!.trim() }, sender),
};
