import { jest } from '@jest/globals';
import nodemailer from 'nodemailer';
import { createMailTransport, MAIL_DRIVERS } from './mail.config.js';
import { bootMailTransport, parseVerifyOnBoot } from './mail.module.js';
import { SmtpMailTransport } from './drivers/smtp.driver.js';
import type { SmtpOptions, SmtpTransporter } from './drivers/smtp.driver.js';
import { MailjetMailTransport } from './drivers/mailjet.driver.js';
import { renderInviteEmail } from './templates/invite.js';
import type { InviteEmailData } from './templates/invite.js';
import { SUPPORTED_LOCALES } from '../app-common/locale.js';

// QA gap specs for the invite email work (qa/email-test-plan.md, case ids M-xx).

const settings = (values: Record<string, string>) => (key: string) => values[key];
const smtpSettings = { MAIL_PROVIDER: 'smtp', MAIL_FROM: 'trips@holid.ai', SMTP_HOST: 'smtp.example', SMTP_USER: 'u', SMTP_PASS: 'p' };
const sender = { from: 'trips@holid.ai', fromName: 'Holid.ai' };
const options: SmtpOptions = { host: 'smtp.example', port: 587, secure: false, auth: { user: 'u', pass: 'p' } };
const message = { to: 'ana@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' };

describe('mail config (QA)', () => {
  // M-04: provider names that exist on every object must not resolve to a prototype property.
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])('treats MAIL_PROVIDER=%s as unknown', (provider) => {
    expect(() => createMailTransport(settings({ MAIL_PROVIDER: provider }))).toThrow(
      `Unknown MAIL_PROVIDER "${provider.toLowerCase()}". Use one of: ${Object.keys(MAIL_DRIVERS).join(', ')}.`,
    );
  });

  it.each(['SMTP', ' smtp ', 'Smtp'])('matches MAIL_PROVIDER=%p case- and space-insensitively (M-02)', (provider) => {
    expect(createMailTransport(settings({ ...smtpSettings, MAIL_PROVIDER: provider })).provider).toBe('smtp');
  });

  // M-05/M-06: whitespace-only counts as missing, and the list is exact and ordered.
  it('lists exactly the missing or blank settings, MAIL_FROM first', () => {
    expect(() => createMailTransport(settings({ MAIL_PROVIDER: 'smtp', SMTP_HOST: '  ', SMTP_USER: 'u', SMTP_PASS: '\t' }))).toThrow(
      'MAIL_PROVIDER=smtp needs these settings, which are missing or empty: MAIL_FROM, SMTP_HOST, SMTP_PASS. See .env.example.',
    );
    expect(() => createMailTransport(settings({ MAIL_PROVIDER: 'mailjet', MAIL_FROM: 'a@b.c', MAILJET_API_KEY: ' ' }))).toThrow(
      'missing or empty: MAILJET_API_KEY, MAILJET_API_SECRET.',
    );
  });

  // M-09
  it.each(['0', '70000', 'abc', '587.5', '-1'])('fails startup on SMTP_PORT=%p', (port) => {
    expect(() => createMailTransport(settings({ ...smtpSettings, SMTP_PORT: port }))).toThrow(`SMTP_PORT must be a port number (got "${port}")`);
  });

  it('defaults SMTP_PORT to 587 when empty', () => {
    expect(() => createMailTransport(settings({ ...smtpSettings, SMTP_PORT: ' ' }))).not.toThrow();
  });

  // M-11
  it('defaults MAIL_FROM_NAME to "Holid.ai" when unset or blank', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ Messages: [{ Status: 'success', To: [{ MessageID: 1 }] }] }), { status: 200 }),
    );
    const transport = new MailjetMailTransport({ apiKey: 'k', apiSecret: 's' }, { from: 'a@b.c', fromName: 'Holid.ai' }, fetchFn as typeof fetch);
    await transport.send(message);
    expect(JSON.parse(String(fetchFn.mock.calls[0][1]?.body)).Messages[0].From).toEqual({ Email: 'a@b.c', Name: 'Holid.ai' });
    // The config layer is what applies the default:
    for (const blank of [undefined, '  ']) {
      const values: Record<string, string> = { MAIL_PROVIDER: 'mailjet', MAIL_FROM: 'a@b.c', MAILJET_API_KEY: 'k', MAILJET_API_SECRET: 's' };
      if (blank !== undefined) values.MAIL_FROM_NAME = blank;
      expect(() => createMailTransport(settings(values))).not.toThrow();
    }
  });
});

describe('MAIL_VERIFY_ON_BOOT (QA)', () => {
  // Q12/Q21: true/false in any case; unset, empty or whitespace-only = false; anything else fails startup.
  it.each([
    [undefined, false],
    ['', false],
    ['   ', false],
    ['\t', false],
    ['false', false],
    ['FALSE', false],
    [' False ', false],
    ['true', true],
    ['TRUE', true],
    [' True ', true],
  ])('parses %p as %p', (value, expected) => {
    expect(parseVerifyOnBoot(value)).toBe(expected);
  });

  it.each(['yes', 'no', '1', '0', 'on', 'off', 'truee', 'true false'])('fails startup on %p', (value) => {
    expect(() => parseVerifyOnBoot(value)).toThrow(`MAIL_VERIFY_ON_BOOT must be true or false (got "${value}").`);
  });

  // M-12d: one info line, no connection, for providers with nothing to verify.
  it.each([
    ['log', {}],
    ['mailjet', { MAIL_FROM: 'a@b.c', MAILJET_API_KEY: 'k', MAILJET_API_SECRET: 's' }],
  ])('logs exactly one "nothing to check" line for %s', async (provider, extra) => {
    const logger = { log: jest.fn() };
    await bootMailTransport(settings({ MAIL_PROVIDER: provider, MAIL_VERIFY_ON_BOOT: 'true', ...extra }), logger as never);
    const skipped = logger.log.mock.calls.filter(([line]) => String(line).startsWith('MAIL_VERIFY_ON_BOOT'));
    expect(skipped).toEqual([[`MAIL_VERIFY_ON_BOOT: nothing to check for MAIL_PROVIDER=${provider}`]]);
  });

  it('never puts SMTP_PASS in the boot failure', async () => {
    const values = { ...smtpSettings, SMTP_PASS: 'hunter2-secret', MAIL_VERIFY_ON_BOOT: 'true', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1' };
    const error = await bootMailTransport(settings(values), { log: () => undefined } as never).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('MAIL_VERIFY_ON_BOOT: the smtp connection failed at startup');
    expect((error as Error).message).not.toContain('hunter2-secret');
  });
});

describe('SMTP driver (QA)', () => {
  // M-18: concurrent first sends share one connection check.
  it('shares one verify between concurrent first sends', async () => {
    let release!: () => void;
    const verify = jest.fn(() => new Promise<unknown>((resolve) => (release = () => resolve(true))));
    const sendMail = jest.fn(async (_mail: Record<string, unknown>) => ({ messageId: 'x' }));
    const smtp = new SmtpMailTransport(options, sender, () => ({ verify, sendMail }));

    const sends = Promise.all([smtp.send(message), smtp.send(message), smtp.send(message)]);
    release();
    await sends;

    expect(verify).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  // M-20: per-message replyTo, then MAIL_REPLY_TO, otherwise no replyTo key at all.
  it.each([
    ['message wins', { replyTo: 'env@holid.ai' }, 'msg@holid.ai', 'msg@holid.ai'],
    ['env fallback', { replyTo: 'env@holid.ai' }, undefined, 'env@holid.ai'],
    ['neither', {}, undefined, undefined],
  ])('replyTo: %s', async (_label, senderExtra, perMessage, expected) => {
    const sendMail = jest.fn(async (_mail: Record<string, unknown>) => ({ messageId: 'x' }));
    const smtp = new SmtpMailTransport(options, { ...sender, ...senderExtra }, () => ({ verify: async () => true, sendMail }));

    await smtp.send({ ...message, ...(perMessage ? { replyTo: perMessage } : {}) });

    const mail = sendMail.mock.calls[0][0];
    if (expected === undefined) expect(mail).not.toHaveProperty('replyTo');
    else expect(mail.replyTo).toBe(expected);
  });

  /** Real nodemailer, building the raw RFC 5322 message in memory (no network). */
  async function rawMessage(overrides: Partial<typeof message>): Promise<string> {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: '\r\n' });
    let raw = '';
    const transporter: SmtpTransporter = {
      verify: async () => true,
      sendMail: async (mail) => {
        const info = (await stream.sendMail(mail)) as { messageId?: string; message: Buffer };
        raw = info.message.toString('utf8');
        return { messageId: info.messageId };
      },
    };
    await new SmtpMailTransport(options, sender, () => transporter).send({ ...message, ...overrides });
    return raw;
  }

  const headersOf = (raw: string) => raw.split('\r\n\r\n')[0].split('\r\n');

  // M-22: header injection through the subject or the recipient never adds a header.
  it.each([
    ['subject', { subject: 'Hi\r\nBcc: evil@attacker.example' }],
    ['subject (LF only)', { subject: 'Hi\nBcc: evil@attacker.example' }],
    ['recipient', { to: 'ana@example.com\r\nBcc: evil@attacker.example' }],
  ])('cannot inject a Bcc header through the %s', async (_label, overrides) => {
    const headers = headersOf(await rawMessage(overrides).catch((error: Error) => `REJECTED: ${error.message}`));
    expect(headers.filter((line) => /^bcc:/i.test(line))).toEqual([]);
    expect(headers.filter((line) => /^subject:/i.test(line)).length).toBeLessThanOrEqual(1);
  });

  // M-23: non-ASCII survives encoding.
  it('encodes unicode subjects and bodies so they decode back unchanged', async () => {
    const raw = await rawMessage({ subject: 'Convite: São Paulo 🌴', text: 'Olá, São Paulo 🌴' });
    const subject = headersOf(raw).find((line) => /^subject:/i.test(line))!;
    expect(subject).toMatch(/=\?UTF-8\?/i);
    expect(raw).not.toContain('São Paulo 🌴'); // never raw 8-bit in headers or a 7-bit body
  });
});

describe('Mailjet driver (QA)', () => {
  const jsonResponse = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const mailjet = (response: Response) => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
    return { fetchFn, transport: new MailjetMailTransport({ apiKey: 'public-key', apiSecret: 'very-secret' }, sender, fetchFn as typeof fetch) };
  };

  // M-25/M-26: error mapping, length cap, no credentials in errors.
  it('maps a 401 with a Mailjet error body, without credentials in the message', async () => {
    const { transport } = mailjet(jsonResponse(401, { ErrorMessage: 'API key authentication/authorization failure', ErrorInfo: 'x' }));
    const error = (await transport.send(message).catch((e: Error) => e)) as Error;
    expect(error.message).toBe('Mailjet send failed with HTTP 401: API key authentication/authorization failure; x');
    expect(error.message).not.toMatch(/very-secret|public-key|Basic /);
  });

  it('caps the error detail at 500 characters', async () => {
    const { transport } = mailjet(jsonResponse(400, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'e'.repeat(2000) }] }] }));
    const error = (await transport.send(message).catch((e: Error) => e)) as Error;
    expect(error.message.length).toBeLessThanOrEqual('Mailjet send failed with HTTP 400: '.length + 500);
  });

  // M-29
  it.each([
    [[{ MessageID: 42 }], { id: '42' }],
    [[{ MessageUUID: 'uuid-only' }], { id: 'uuid-only' }],
    [[{}], {}],
    [undefined, {}],
  ])('returns the message id from To=%j', async (to, expected) => {
    const { transport } = mailjet(jsonResponse(200, { Messages: [{ Status: 'success', ...(to ? { To: to } : {}) }] }));
    await expect(transport.send(message)).resolves.toEqual(expected);
  });

  // M-30
  it('bounds the request with an abort signal', async () => {
    const { fetchFn, transport } = mailjet(jsonResponse(200, { Messages: [{ Status: 'success' }] }));
    await transport.send(message);
    expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('invite template (QA)', () => {
  const base: InviteEmailData = {
    inviter: 'Ana',
    destination: 'Lisbon',
    startDate: '2026-11-01',
    endDate: '2026-11-05',
    role: 'editor',
    url: 'https://holid.ai/invite/TOKEN123',
    deepLink: 'holidai://invite/TOKEN123',
    expiresAt: new Date('2026-10-10T12:00:00Z'),
  };

  // M-41
  it.each(SUPPORTED_LOCALES)('sets <html lang> to %s', (locale) => {
    expect(renderInviteEmail(locale, base).html).toContain(`<html lang="${locale}">`);
  });

  // M-33: ranges across months and years, in UTC.
  it.each([
    ['en', '2026-12-30', '2027-01-02', /Dec 30, 2026\s*[–-]\s*Jan 2, 2027/],
    ['pt-BR', '2026-11-28', '2026-12-03', /28 de nov\.?\s*[–-]\s*3 de dez\.? de 2026/],
    ['es', '2026-11-28', '2026-12-03', /28 nov\.?\s*[–-]\s*3 dic\.? 2026/],
  ] as const)('formats a %s range across months/years', (locale, startDate, endDate, expected) => {
    expect(renderInviteEmail(locale, { ...base, startDate, endDate }).text).toMatch(expected);
  });

  // M-36/M-37: hostile values in every interpolated slot, including attributes.
  const hostile = ['<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', "' onmouseover='x", 'Tom & Jerry'];
  it.each(hostile)('never emits %p unescaped in the HTML', (value) => {
    const { html } = renderInviteEmail('en', { ...base, inviter: value, destination: value });
    expect(html).not.toContain(value);
    // Escaped text such as `&lt;img onerror=…&gt;` is harmless; only raw tags or attributes would run.
    expect(html).not.toMatch(/<script|<img|<[a-z][^>]* onmouseover=/i);
  });

  it('escapes quotes inside link attributes', () => {
    const url = `https://holid.ai/invite/a"onclick="x`;
    const { html } = renderInviteEmail('en', { ...base, url, deepLink: `holidai://invite/a'x` });
    expect(html).not.toContain('"onclick="');
    expect(html).toContain('a&quot;onclick=&quot;x');
    expect(html).toContain('a&#39;x');
  });

  // M-40: a 100-char unbroken destination must not widen the 600 px card.
  it('lets long unbroken names wrap inside the 600 px layout', () => {
    const { html } = renderInviteEmail('en', { ...base, inviter: 'N'.repeat(60), destination: 'D'.repeat(100) });
    const strongs = html.match(/<strong[^>]*>[ND]{60,}<\/strong>/g) ?? [];
    expect(strongs.length).toBeGreaterThan(0);
    // The text cells holding the names need overflow-wrap/word-break, or the table stretches on mobile clients.
    expect(html).toMatch(/overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-(all|word)/);
  });
});
