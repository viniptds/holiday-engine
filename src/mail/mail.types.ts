/** A provider-neutral email. `html` and `text` are both sent; clients pick the one they can show. */
export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Overrides MAIL_REPLY_TO for this message. */
  replyTo?: string;
  /** Labels for the provider's analytics, where it supports them (e.g. `trip-invite`). */
  tags?: string[];
  /**
   * A stable key for this email (e.g. `trip-invite/<invite id>`), so a retried send can't deliver it
   * twice where the provider supports it (Resend's `Idempotency-Key`). Never put secrets in it.
   */
  idempotencyKey?: string;
};

/** Sends email through one provider. Pick it with MAIL_PROVIDER; inject it with `MAIL_TRANSPORT`. */
export interface MailTransport {
  /** The MAIL_PROVIDER value, for logs. */
  readonly provider: string;
  /**
   * Resolves with the provider's message id when it gives one; rejects if the provider refuses the
   * message. When `signal` aborts, rejects with its reason and cancels the request where the
   * provider allows it (fetch-based drivers); otherwise the late result is ignored.
   */
  send(message: MailMessage, signal?: AbortSignal): Promise<{ id?: string }>;
  /** Checks the provider can be reached (used by MAIL_VERIFY_ON_BOOT). Drivers without a connection omit it. */
  verify?(): Promise<void>;
}

export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');

/** Sender settings shared by every driver. */
export type MailSender = {
  /** MAIL_FROM (empty only for the log driver). */
  from: string;
  /** MAIL_FROM_NAME, default "Holid.ai". */
  fromName: string;
  /** MAIL_REPLY_TO. */
  replyTo?: string;
};

/** Reads one setting (ConfigService.get or a plain env lookup). */
export type SettingReader = (key: string) => string | undefined;

/**
 * One provider: the settings it needs (checked at startup) and how to build its transport.
 * Adding a provider = a driver file exporting one of these + an entry in `MAIL_DRIVERS`.
 */
export type MailDriver = {
  /** Settings that must be non-empty, besides MAIL_FROM (which every driver but `log` needs). */
  required: string[];
  /** Whether MAIL_FROM is needed (false only for `log`). */
  needsFrom: boolean;
  create(setting: SettingReader, sender: MailSender): MailTransport;
};

/** `"Name" <address>` for logs and headers. */
export const formatSender = ({ from, fromName }: MailSender) => (from ? `${fromName} <${from}>` : fromName);
