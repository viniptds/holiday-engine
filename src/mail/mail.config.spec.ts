import { jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { createMailTransport, MAIL_DRIVERS } from './mail.config.js';
import { MailModule, bootMailTransport, parseVerifyOnBoot } from './mail.module.js';
import { MAIL_TRANSPORT } from './mail.types.js';
import type { MailTransport } from './mail.types.js';
import { LogMailTransport } from './drivers/log.driver.js';
import { SmtpMailTransport } from './drivers/smtp.driver.js';
import { MailjetMailTransport } from './drivers/mailjet.driver.js';
import { ResendMailTransport } from './drivers/resend.driver.js';

const reader = (env: Record<string, string>) => (key: string) => env[key];
const SMTP = { MAIL_FROM: 'trips@holid.ai', SMTP_HOST: 'in-v3.mailjet.com', SMTP_USER: 'key', SMTP_PASS: 'secret-pass' };
const MAILJET = { MAIL_FROM: 'trips@holid.ai', MAILJET_API_KEY: 'key', MAILJET_API_SECRET: 'secret-api' };
const RESEND = { MAIL_FROM: 'trips@holid.ai', RESEND_API_KEY: 're_secret_key' };

/** The error `createMailTransport` throws for `env`. */
function startupError(env: Record<string, string>): string {
  try {
    createMailTransport(reader(env));
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a startup error');
}

describe('createMailTransport', () => {
  it('uses the log driver by default, without MAIL_FROM', () => {
    expect(createMailTransport(reader({}))).toBeInstanceOf(LogMailTransport);
    expect(createMailTransport(reader({ MAIL_PROVIDER: ' ' }))).toBeInstanceOf(LogMailTransport);
  });

  it.each<[string, Record<string, string>, new (...args: never[]) => MailTransport]>([
    ['log', {}, LogMailTransport],
    ['smtp', SMTP, SmtpMailTransport],
    ['SMTP', SMTP, SmtpMailTransport],
    ['mailjet', MAILJET, MailjetMailTransport],
    ['resend', RESEND, ResendMailTransport],
    ['Resend', RESEND, ResendMailTransport],
  ])('selects the %s driver', (provider, env, type) => {
    const transport = createMailTransport(reader({ ...env, MAIL_PROVIDER: provider }));

    expect(transport).toBeInstanceOf(type);
    expect(transport.provider).toBe(provider.toLowerCase());
  });

  it('fails on an unknown provider, naming the known ones', () => {
    expect(startupError({ MAIL_PROVIDER: 'sendgrid-api' })).toBe('Unknown MAIL_PROVIDER "sendgrid-api". Use one of: log, smtp, mailjet, resend.');
    expect(startupError({ MAIL_PROVIDER: 'constructor' })).toContain('Unknown MAIL_PROVIDER');
  });

  it.each<[string, Record<string, string>, string[]]>([
    ['smtp', {}, ['MAIL_FROM', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS']],
    ['smtp', { MAIL_FROM: 'a@b.c', SMTP_HOST: 'h', SMTP_USER: 'u' }, ['SMTP_PASS']],
    ['smtp', { ...SMTP, MAIL_FROM: '  ' }, ['MAIL_FROM']],
    ['mailjet', {}, ['MAIL_FROM', 'MAILJET_API_KEY', 'MAILJET_API_SECRET']],
    ['mailjet', { MAIL_FROM: 'a@b.c', MAILJET_API_KEY: 'k' }, ['MAILJET_API_SECRET']],
    ['resend', {}, ['MAIL_FROM', 'RESEND_API_KEY']],
    ['resend', { MAIL_FROM: 'a@b.c' }, ['RESEND_API_KEY']],
    ['resend', { RESEND_API_KEY: 're_secret_key' }, ['MAIL_FROM']],
    ['resend', { MAIL_FROM: 'a@b.c', RESEND_API_KEY: '   ' }, ['RESEND_API_KEY']],
  ])('fails for %s listing the missing keys (%j)', (provider, env, missing) => {
    const message = startupError({ ...env, MAIL_PROVIDER: provider });

    expect(message).toBe(`MAIL_PROVIDER=${provider} needs these settings, which are missing or empty: ${missing.join(', ')}. See .env.example.`);
  });

  it('never puts setting values in its errors', () => {
    expect(startupError({ MAIL_PROVIDER: 'smtp', SMTP_PASS: 'secret-pass', SMTP_USER: 'key' })).not.toContain('secret-pass');
    expect(startupError({ MAIL_PROVIDER: 'smtp', ...SMTP, SMTP_PORT: 'abc' })).toBe('SMTP_PORT must be a port number (got "abc")');
  });

  it('declares, for every driver, whether it needs MAIL_FROM', () => {
    expect(Object.fromEntries(Object.entries(MAIL_DRIVERS).map(([name, d]) => [name, d.needsFrom]))).toEqual({
      log: false,
      smtp: true,
      mailjet: true,
      resend: true,
    });
  });
});

describe('MailModule', () => {
  const boot = (env: Record<string, string>) =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => env] }), MailModule],
    }).compile();

  it('provides the configured transport', async () => {
    const moduleRef = await boot({ MAIL_PROVIDER: 'mailjet', ...MAILJET });

    expect(moduleRef.get(MAIL_TRANSPORT)).toBeInstanceOf(MailjetMailTransport);
  });

  it('provides the Resend transport without calling Resend at startup', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    try {
      const moduleRef = await boot({ MAIL_PROVIDER: 'resend', ...RESEND, MAIL_VERIFY_ON_BOOT: 'true' });

      expect(moduleRef.get(MAIL_TRANSPORT)).toBeInstanceOf(ResendMailTransport);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('fails startup naming RESEND_API_KEY, never a value', async () => {
    const error = (await boot({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'trips@holid.ai' }).catch((e: Error) => e)) as Error;

    expect(error.message).toBe('MAIL_PROVIDER=resend needs these settings, which are missing or empty: RESEND_API_KEY. See .env.example.');
  });

  it('fails startup when the provider lacks its settings', async () => {
    await expect(boot({ MAIL_PROVIDER: 'smtp', MAIL_FROM: 'trips@holid.ai' })).rejects.toThrow(
      'MAIL_PROVIDER=smtp needs these settings, which are missing or empty: SMTP_HOST, SMTP_USER, SMTP_PASS.',
    );
  });

  it('does not connect to the SMTP server at startup', async () => {
    // An unreachable host would fail a startup check; the module still boots.
    const moduleRef = await boot({ MAIL_PROVIDER: 'smtp', ...SMTP, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' });

    expect(moduleRef.get(MAIL_TRANSPORT)).toBeInstanceOf(SmtpMailTransport);
  });
});

describe('MAIL_VERIFY_ON_BOOT', () => {
  const boot = (env: Record<string, string>) =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, ignoreEnvVars: true, load: [() => env] }), MailModule],
    }).compile();
  // Port 1 on loopback refuses at once: a real nodemailer check that fails without any network.
  const unreachable = { MAIL_PROVIDER: 'smtp', ...SMTP, SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' };

  it('fails startup with a clear error when the SMTP server is unreachable', async () => {
    const error = (await boot({ ...unreachable, MAIL_VERIFY_ON_BOOT: 'true' }).catch((e: Error) => e)) as Error;

    expect(error.message).toMatch(/^MAIL_VERIFY_ON_BOOT: the smtp connection failed at startup: SMTP connection check failed: .*ECONNREFUSED/);
    expect(error.message).toContain('Check the SMTP_* settings');
    expect(error.message).not.toContain('secret-pass');
  });

  it('is off by default (and with false), so the same settings still boot', async () => {
    await expect(boot(unreachable)).resolves.toBeDefined();
    await expect(boot({ ...unreachable, MAIL_VERIFY_ON_BOOT: 'false' })).resolves.toBeDefined();
  });

  it.each(['yes', '1', 'on', 'tru'])('fails startup on MAIL_VERIFY_ON_BOOT=%s', async (value) => {
    await expect(boot({ MAIL_VERIFY_ON_BOOT: value })).rejects.toThrow(`MAIL_VERIFY_ON_BOOT must be true or false (got "${value}").`);
  });

  it.each([
    ['TRUE', true],
    [' True ', true],
    ['FALSE', false],
    ['', false],
    [undefined, false],
  ])('reads MAIL_VERIFY_ON_BOOT=%p as %s', (value, expected) => {
    expect(parseVerifyOnBoot(value)).toBe(expected);
  });

  it.each([
    ['log', {}],
    ['mailjet', MAILJET],
  ])('logs one info line and checks nothing for %s', async (provider, env) => {
    const logger = { log: jest.fn((_message: string) => undefined) };

    await bootMailTransport(reader({ MAIL_PROVIDER: provider, ...env, MAIL_VERIFY_ON_BOOT: 'true' }), logger as never);

    expect(logger.log.mock.calls.map(([m]) => m)).toEqual([
      `Email provider: ${provider}`,
      `MAIL_VERIFY_ON_BOOT: nothing to check for MAIL_PROVIDER=${provider}`,
    ]);
  });

  it('boots when the check passes, and has nothing to check for log or mailjet', async () => {
    const verify = jest.spyOn(SmtpMailTransport.prototype, 'verify').mockResolvedValueOnce(undefined);

    await expect(boot({ ...unreachable, MAIL_VERIFY_ON_BOOT: 'true' })).resolves.toBeDefined();
    expect(verify).toHaveBeenCalledTimes(1);
    verify.mockRestore();
    await expect(boot({ MAIL_VERIFY_ON_BOOT: 'true' })).resolves.toBeDefined();
    await expect(boot({ MAIL_PROVIDER: 'mailjet', ...MAILJET, MAIL_VERIFY_ON_BOOT: 'true' })).resolves.toBeDefined();
  });
});
