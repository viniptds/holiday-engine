import { Logger } from '@nestjs/common';
import type { MailDriver, MailMessage, MailSender, MailTransport } from '../mail.types.js';
import { redactLinks } from '../redact.js';

/**
 * MAIL_PROVIDER=log (default): sends nothing. Logs the subject and tags at info and the text body
 * at debug, never the recipient's address, and with every link replaced by `[link]` (invite links
 * carry live tokens).
 */
export class LogMailTransport implements MailTransport {
  readonly provider = 'log';
  private readonly logger = new Logger('Mail');

  constructor(private readonly sender: MailSender) {}

  async send(message: MailMessage, signal?: AbortSignal): Promise<{ id?: string }> {
    signal?.throwIfAborted();
    const tags = message.tags?.length ? ` [${message.tags.join(', ')}]` : '';
    this.logger.log(`Not sent (MAIL_PROVIDER=log): subject "${message.subject}"${tags}`);
    this.logger.debug(`From ${this.sender.fromName}${this.sender.from ? ` <${this.sender.from}>` : ''}\n${redactLinks(message.text)}`);
    return {};
  }
}

export const logDriver: MailDriver = {
  required: [],
  needsFrom: false,
  create: (_setting, sender) => new LogMailTransport(sender),
};
