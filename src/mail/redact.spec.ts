import { redactEmails, redactLinks, redactProviderError, redactValues } from './redact.js';

describe('redact', () => {
  it('replaces web and app links', () => {
    expect(redactLinks('Open: https://holid.ai/invite/abc?x=1 or holidai://invite/abc.')).toBe('Open: [link] or [link]');
  });

  it('replaces every occurrence of each value and ignores empty ones', () => {
    expect(redactValues('a@b.c sent a@b.c TOKEN', [['a@b.c', '[invitee]'], ['TOKEN', '[token]'], [null, 'x'], ['', 'y']])).toBe(
      '[invitee] sent [invitee] [token]',
    );
  });

  it('ignores case, and treats the values literally (no RegExp injection)', () => {
    expect(redactValues('550 <ANA.SILVA@EXAMPLE.COM> and Ana.Silva@Example.com', [['ana.silva@example.com', '[x]']])).toBe(
      '550 <[x]> and [x]',
    );
    expect(redactValues('a.b+c$1 and aXb+c$1', [['a.b+c$1', '[x]']])).toBe('[x] and aXb+c$1');
  });

  it('replaces anything shaped like an email address', () => {
    expect(redactEmails('rejected <Other.Person+tag@Sub.Example.CO.uk>; cc bob@x.io; not an address: a@b, @c.d')).toBe(
      'rejected <[email]>; cc [email]; not an address: a@b, @c.d',
    );
  });

  it('makes provider errors safe to log: secrets in any case, other addresses, links', () => {
    const token = 'kq3V9xYzAbCdEfGhIjKlMnOpQrStUvWxYz0123456_-';
    const text = `550 <INVITEE@EXAMPLE.COM> rejected (also ccd admin@holid.ai); body: https://holid.ai/invite/${token} holidai://invite/${token} ${token}`;

    expect(redactProviderError(text, [token, 'invitee@example.com'])).toBe(
      '550 <[redacted]> rejected (also ccd [email]); body: [link] [link] [redacted]',
    );
  });
});
