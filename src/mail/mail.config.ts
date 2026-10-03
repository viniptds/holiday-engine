import type { MailDriver, MailSender, MailTransport, SettingReader } from './mail.types.js';
import { logDriver } from './drivers/log.driver.js';
import { smtpDriver } from './drivers/smtp.driver.js';
import { mailjetDriver } from './drivers/mailjet.driver.js';

/** Every provider MAIL_PROVIDER can name. Add a provider: a driver file + one entry here. */
export const MAIL_DRIVERS: Record<string, MailDriver> = {
  log: logDriver,
  smtp: smtpDriver,
  mailjet: mailjetDriver,
};

export const DEFAULT_MAIL_PROVIDER = 'log';
export const DEFAULT_MAIL_FROM_NAME = 'Holid.ai';

const value = (setting: SettingReader, key: string) => setting(key)?.trim() || undefined;

/**
 * Builds the transport MAIL_PROVIDER names, failing (at startup) on an unknown provider or with
 * the list of missing settings. Never includes setting values in errors.
 */
export function createMailTransport(setting: SettingReader): MailTransport {
  const provider = (value(setting, 'MAIL_PROVIDER') ?? DEFAULT_MAIL_PROVIDER).toLowerCase();
  const driver = Object.hasOwn(MAIL_DRIVERS, provider) ? MAIL_DRIVERS[provider] : undefined;
  if (!driver) {
    throw new Error(`Unknown MAIL_PROVIDER "${provider}". Use one of: ${Object.keys(MAIL_DRIVERS).join(', ')}.`);
  }
  const missing = [...(driver.needsFrom ? ['MAIL_FROM'] : []), ...driver.required].filter((key) => !value(setting, key));
  if (missing.length > 0) {
    throw new Error(
      `MAIL_PROVIDER=${provider} needs these settings, which are missing or empty: ${missing.join(', ')}. See .env.example.`,
    );
  }
  const sender: MailSender = {
    from: value(setting, 'MAIL_FROM') ?? '',
    fromName: value(setting, 'MAIL_FROM_NAME') ?? DEFAULT_MAIL_FROM_NAME,
    replyTo: value(setting, 'MAIL_REPLY_TO'),
  };
  return driver.create(setting, sender);
}
