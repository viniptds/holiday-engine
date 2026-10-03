import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createMailTransport } from './mail.config.js';
import { MAIL_TRANSPORT } from './mail.types.js';
import type { MailTransport, SettingReader } from './mail.types.js';

/** MAIL_VERIFY_ON_BOOT: `true` or `false` (any case); unset or empty is false; anything else fails startup. */
export function parseVerifyOnBoot(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  throw new Error(`MAIL_VERIFY_ON_BOOT must be true or false (got "${value}").`);
}

/**
 * Builds the transport and, with MAIL_VERIFY_ON_BOOT=true, checks the connection before the app
 * starts (otherwise the SMTP driver checks on the first send, so a missing server doesn't stop boot).
 */
export async function bootMailTransport(setting: SettingReader, logger = new Logger('Mail')): Promise<MailTransport> {
  const verifyOnBoot = parseVerifyOnBoot(setting('MAIL_VERIFY_ON_BOOT'));
  const transport = createMailTransport(setting);
  logger.log(`Email provider: ${transport.provider}`);
  if (verifyOnBoot) {
    if (!transport.verify) {
      logger.log(`MAIL_VERIFY_ON_BOOT: nothing to check for MAIL_PROVIDER=${transport.provider}`);
    } else {
      try {
        await transport.verify();
      } catch (error) {
        throw new Error(
          `MAIL_VERIFY_ON_BOOT: the ${transport.provider} connection failed at startup: ` +
            `${error instanceof Error ? error.message : String(error)}. Check the SMTP_* settings, or set MAIL_VERIFY_ON_BOOT=false.`,
        );
      }
      logger.log(`MAIL_VERIFY_ON_BOOT: ${transport.provider} connection OK`);
    }
  }
  return transport;
}

/** Provides `MAIL_TRANSPORT` for MAIL_PROVIDER. Startup fails if the provider is unknown or misconfigured. */
@Module({
  providers: [
    {
      provide: MAIL_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => bootMailTransport((key) => config.get<string>(key)),
    },
  ],
  exports: [MAIL_TRANSPORT],
})
export class MailModule {}
