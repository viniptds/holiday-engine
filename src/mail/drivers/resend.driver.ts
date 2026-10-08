import type { MailDriver, MailMessage, MailSender, MailTransport, SettingReader } from '../mail.types.js';
import { redactProviderError } from '../redact.js';

// Resend REST API: https://resend.com/docs/api-reference/emails/send-email
export const RESEND_SEND_URL = 'https://api.resend.com/emails';
const TIMEOUT_MS = 15_000;
/** Resend's limits: tag names and values ASCII letters, digits, `_` and `-`, up to 256 characters; idempotency keys 1-256 characters. */
const TAG_MAX = 256;
const IDEMPOTENCY_KEY_MAX = 256;

type Fetch = typeof fetch;
/** Resend's error body: `{ statusCode, name, message }` (e.g. `validation_error`, `rate_limit_exceeded`). */
type ResendError = { statusCode?: number | null; name?: string; message?: string };
type ResendTag = { name: string; value: string };

/** A tag name or value reduced to the characters Resend accepts; empty if nothing is left. */
export const sanitizeTagPart = (value: string): string =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, TAG_MAX);

/**
 * Message tags as Resend tags. `name:value` keeps its name; a plain tag (e.g. `trip-invite`)
 * becomes `category`. The first tag for a name wins; tags left empty after sanitizing are dropped.
 */
export function toResendTags(tags: string[] | undefined): ResendTag[] {
  const byName = new Map<string, string>();
  for (const tag of tags ?? []) {
    const split = tag.indexOf(':');
    const name = sanitizeTagPart(split === -1 ? 'category' : tag.slice(0, split));
    const value = sanitizeTagPart(split === -1 ? tag : tag.slice(split + 1));
    if (name && value && !byName.has(name)) byName.set(name, value);
  }
  return [...byName].map(([name, value]) => ({ name, value }));
}

/** `Name <address>`, quoting the name when it has characters an address header treats specially. */
export function resendFrom({ from, fromName }: MailSender): string {
  const name = fromName.replace(/[\r\n]+/g, ' ').trim();
  if (!name) return from;
  return /^[\p{L}\p{N} ._'-]+$/u.test(name) ? `${name} <${from}>` : `"${name.replace(/(["\\])/g, '\\$1')}" <${from}>`;
}

/**
 * MAIL_PROVIDER=resend: Resend's REST API over the built-in fetch (no SDK), with
 * `Authorization: Bearer RESEND_API_KEY`. A message's `idempotencyKey` is sent as `Idempotency-Key`,
 * so a retried send within Resend's 24 h window can't email twice.
 */
export class ResendMailTransport implements MailTransport {
  readonly provider = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly sender: MailSender,
    private readonly fetchFn: Fetch = (...args) => fetch(...args),
  ) {}

  async send(message: MailMessage, signal?: AbortSignal): Promise<{ id?: string }> {
    const replyTo = message.replyTo ?? this.sender.replyTo;
    const tags = toResendTags(message.tags);
    const payload = {
      from: resendFrom(this.sender),
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(tags.length ? { tags } : {}),
    };
    const idempotencyKey = message.idempotencyKey?.trim().slice(0, IDEMPOTENCY_KEY_MAX);
    const response = await this.fetchFn(RESEND_SEND_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: JSON.stringify(payload),
      // The caller's signal cancels the HTTP request itself.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => null)) as (ResendError & { id?: string }) | null;
    if (!response.ok) {
      const name = typeof body?.name === 'string' ? sanitizeTagPart(body.name) : '';
      const details =
        typeof body?.message === 'string' && body.message
          ? redactProviderError(body.message, [this.apiKey, message.to]).slice(0, 500)
          : 'no details';
      throw new Error(`Resend send failed with HTTP ${response.status}${name ? ` (${name})` : ''}: ${details}`);
    }
    return typeof body?.id === 'string' && body.id ? { id: body.id } : {};
  }
}

export const resendDriver: MailDriver = {
  required: ['RESEND_API_KEY'],
  needsFrom: true,
  create: (setting: SettingReader, sender) => new ResendMailTransport(setting('RESEND_API_KEY')!.trim(), sender),
};
