import nodemailer from 'nodemailer';
import type { MailDriver, MailMessage, MailSender, MailTransport, SettingReader } from '../mail.types.js';
import { abortable } from '../abort.js';

/** What we use of a nodemailer transporter (the tests pass a fake). */
export type SmtpTransporter = {
  verify(): Promise<unknown>;
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string }>;
};

export type SmtpOptions = { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };

export type CreateTransporter = (options: SmtpOptions) => SmtpTransporter;

const nodemailerTransporter: CreateTransporter = (options) =>
  nodemailer.createTransport({ ...options, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });

/**
 * MAIL_PROVIDER=smtp, through nodemailer: any SMTP relay (Mailjet in-v3.mailjet.com:587, SendGrid,
 * SES, ...). SMTP_SECURE=false (default) upgrades with STARTTLS; true is TLS from the start (port 465).
 * The connection is checked on the first send, not at startup, so a missing server doesn't stop boot.
 */
export class SmtpMailTransport implements MailTransport {
  readonly provider = 'smtp';
  private readonly transporter: SmtpTransporter;
  private verified: Promise<unknown> | null = null;

  constructor(
    options: SmtpOptions,
    private readonly sender: MailSender,
    createTransporter: CreateTransporter = nodemailerTransporter,
  ) {
    this.transporter = createTransporter(options);
  }

  /** Connects and authenticates once (remembered); a failure is retried on the next call. */
  async verify(): Promise<void> {
    this.verified ??= this.transporter.verify().catch((error: unknown) => {
      this.verified = null; // try again next time
      throw new Error(`SMTP connection check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.verified;
  }

  /**
   * nodemailer can't cancel an SMTP transaction once it has started, so an abort makes this reject
   * at once and the late result is ignored (the connection ends by its own timeouts).
   */
  async send(message: MailMessage, signal?: AbortSignal): Promise<{ id?: string }> {
    await abortable(this.verify(), signal);
    const info = await abortable(this.transporter.sendMail({
      from: { name: this.sender.fromName, address: this.sender.from },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...((message.replyTo ?? this.sender.replyTo) ? { replyTo: message.replyTo ?? this.sender.replyTo } : {}),
    }), signal);
    return { id: info.messageId };
  }
}

const parsePort = (value: string | undefined): number => {
  const port = Number(value?.trim() || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SMTP_PORT must be a port number (got "${value}")`);
  return port;
};

export const smtpDriver: MailDriver = {
  required: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'],
  needsFrom: true,
  create: (setting: SettingReader, sender) =>
    new SmtpMailTransport(
      {
        host: setting('SMTP_HOST')!.trim(),
        port: parsePort(setting('SMTP_PORT')),
        secure: setting('SMTP_SECURE')?.trim().toLowerCase() === 'true',
        auth: { user: setting('SMTP_USER')!.trim(), pass: setting('SMTP_PASS')! },
      },
      sender,
    ),
};
