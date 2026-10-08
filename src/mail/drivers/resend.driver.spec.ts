import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { RESEND_SEND_URL, ResendMailTransport, resendFrom, sanitizeTagPart, toResendTags } from './resend.driver.js';

const API_KEY = 're_live_very_secret_key';
const sender = { from: 'trips@holid.ai', fromName: 'Holid.ai', replyTo: 'hello@holid.ai' };
const message = {
  to: 'ana@example.com',
  subject: 'Hi',
  text: 'Join: https://holid.ai/invite/tok3n',
  html: '<p><a href="https://holid.ai/invite/tok3n">Join</a></p>',
  tags: ['trip-invite'],
  idempotencyKey: 'trip-invite/0b9f5a52-58d4-4a8e-9a4c-0a4c3d2e1f00',
};

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function resend(response: Response | Error, overrides: Partial<typeof sender> = {}) {
  const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetchFn, transport: new ResendMailTransport(API_KEY, { ...sender, ...overrides }, fetchFn as typeof fetch) };
}

const failure = async (transport: ResendMailTransport) => (await transport.send(message).catch((e: Error) => e)) as Error;

describe('ResendMailTransport', () => {
  it('posts the email to /emails with Bearer auth and the idempotency key, and returns Resend\'s id', async () => {
    const { fetchFn, transport } = resend(jsonResponse(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));

    await expect(transport.send(message)).resolves.toEqual({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(RESEND_SEND_URL);
    expect(RESEND_SEND_URL).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      authorization: `Bearer ${API_KEY}`,
      'content-type': 'application/json',
      'idempotency-key': 'trip-invite/0b9f5a52-58d4-4a8e-9a4c-0a4c3d2e1f00',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      from: 'Holid.ai <trips@holid.ai>',
      to: ['ana@example.com'],
      subject: 'Hi',
      html: message.html,
      text: message.text,
      reply_to: 'hello@holid.ai',
      tags: [{ name: 'category', value: 'trip-invite' }],
    });
  });

  it("uses the message's replyTo over MAIL_REPLY_TO", async () => {
    const { fetchFn, transport } = resend(jsonResponse(200, { id: 'x' }));

    await transport.send({ ...message, replyTo: 'owner@holid.ai' });

    expect(JSON.parse(fetchFn.mock.calls[0][1]?.body as string).reply_to).toBe('owner@holid.ai');
  });

  it('leaves out reply_to, tags and Idempotency-Key when there are none', async () => {
    const { fetchFn, transport } = resend(jsonResponse(200, { id: 'x' }), { replyTo: undefined });

    await transport.send({ ...message, tags: undefined, idempotencyKey: '  ' });

    const [, init] = fetchFn.mock.calls[0];
    const body = JSON.parse(init?.body as string);
    expect(body).not.toHaveProperty('reply_to');
    expect(body).not.toHaveProperty('tags');
    expect(init?.headers).not.toHaveProperty('idempotency-key');
  });

  it('caps the idempotency key at 256 characters', async () => {
    const { fetchFn, transport } = resend(jsonResponse(200, { id: 'x' }));

    await transport.send({ ...message, idempotencyKey: 'k'.repeat(300) });

    expect((fetchFn.mock.calls[0][1]?.headers as Record<string, string>)['idempotency-key']).toHaveLength(256);
  });

  it('sends the same idempotency key on a retry of the same email', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, { id: 'same' }));
    const transport = new ResendMailTransport(API_KEY, sender, fetchFn as typeof fetch);

    await transport.send(message);
    await transport.send(message);

    const keys = fetchFn.mock.calls.map(([, init]) => (init?.headers as Record<string, string>)['idempotency-key']);
    expect(keys).toEqual([message.idempotencyKey, message.idempotencyKey]);
  });

  it('resolves without an id when a 2xx has none', async () => {
    const { transport } = resend(new Response('', { status: 200 }));

    await expect(transport.send(message)).resolves.toEqual({});
  });

  // Resend errors are `{ statusCode, name, message }` (https://resend.com/docs/api-reference/errors).
  it.each<[string, number, { statusCode: number; name: string; message: string }, string]>([
    ['missing key', 401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key in the authorization header.' }, 'HTTP 401 (missing_api_key): Missing API key'],
    ['bad key', 403, { statusCode: 403, name: 'restricted_api_key', message: `API key ${API_KEY} is invalid` }, 'HTTP 403 (restricted_api_key): API key [redacted] is invalid'],
    [
      'unverified domain',
      403,
      { statusCode: 403, name: 'validation_error', message: 'The holid.ai domain is not verified. Please, add and verify your domain on https://resend.com/domains' },
      'HTTP 403 (validation_error): The holid.ai domain is not verified. Please, add and verify your domain on [link]',
    ],
    [
      'testing sender to someone else',
      403,
      { statusCode: 403, name: 'validation_error', message: 'You can only send testing emails to your own email address (owner@holid.ai). To send to ana@example.com, verify a domain.' },
      'HTTP 403 (validation_error): You can only send testing emails to your own email address ([email]). To send to [redacted], verify a domain.',
    ],
    ['invalid field', 422, { statusCode: 422, name: 'invalid_parameter', message: 'Invalid `to` field: ANA@EXAMPLE.COM' }, 'HTTP 422 (invalid_parameter): Invalid `to` field: [redacted]'],
    ['idempotency conflict', 409, { statusCode: 409, name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' }, 'HTTP 409 (invalid_idempotent_request)'],
    ['rate limit', 429, { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests. You can only make 2 requests per second.' }, 'HTTP 429 (rate_limit_exceeded): Too many requests'],
    ['quota', 429, { statusCode: 429, name: 'daily_quota_exceeded', message: 'You have reached your daily email sending quota.' }, 'HTTP 429 (daily_quota_exceeded)'],
    ['server error', 500, { statusCode: 500, name: 'application_error', message: 'An unexpected error occurred.' }, 'HTTP 500 (application_error): An unexpected error occurred.'],
  ])('fails a send on %s, naming the error without the key or the recipient', async (_label, status, body, expected) => {
    const { transport } = resend(jsonResponse(status, body));

    const error = await failure(transport);

    expect(error.message).toContain(`Resend send failed with ${expected}`);
    expect(error.message).not.toContain(API_KEY);
    expect(error.message.toLowerCase()).not.toContain('ana@example.com');
  });

  it('fails a 5xx without a JSON body', async () => {
    const { transport } = resend(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(transport.send(message)).rejects.toThrow('Resend send failed with HTTP 502: no details');
  });

  it('sanitizes an odd error name', async () => {
    const { transport } = resend(jsonResponse(400, { name: 'weird name\n<x>', message: 'Bad' }));

    await expect(transport.send(message)).rejects.toThrow('Resend send failed with HTTP 400 (weird_name_x_): Bad');
  });

  it("cancels the HTTP request when the caller's signal aborts", async () => {
    const fetchFn = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const transport = new ResendMailTransport(API_KEY, sender, fetchFn as typeof fetch);
    const controller = new AbortController();

    const pending = transport.send(message, controller.signal);
    controller.abort(new Error('timed out after 15000 ms'));

    await expect(pending).rejects.toThrow('timed out after 15000 ms');
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('does not call Resend with an already aborted signal', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      init?.signal?.throwIfAborted();
      return jsonResponse(200, { id: 'x' });
    });
    const transport = new ResendMailTransport(API_KEY, sender, fetchFn as typeof fetch);

    await expect(transport.send(message, AbortSignal.abort(new Error('the engine is shutting down')))).rejects.toThrow('the engine is shutting down');
  });

  it('times out after 15 s on its own', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    try {
      const { fetchFn, transport } = resend(jsonResponse(200, { id: 'x' }));
      await transport.send(message);
      expect(timeout).toHaveBeenCalledWith(15_000);

      const timedOut = new AbortController();
      timeout.mockReturnValueOnce(timedOut.signal);
      const hanging = new ResendMailTransport(
        API_KEY,
        sender,
        ((_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch,
      );
      const pending = hanging.send(message);
      timedOut.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      await expect(pending).rejects.toThrow('due to timeout');
      expect(fetchFn).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it('passes on network errors', async () => {
    const { transport } = resend(new Error('fetch failed'));

    await expect(transport.send(message)).rejects.toThrow('fetch failed');
  });

  it('logs nothing itself (no key, recipient or link can leak from the driver)', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    try {
      await resend(jsonResponse(200, { id: 'x' })).transport.send(message);
      await failure(resend(jsonResponse(401, { name: 'missing_api_key', message: 'no' })).transport);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('Resend tags', () => {
  it.each([
    ['trip-invite', 'trip-invite'],
    ['Trip Invite!', 'Trip_Invite_'],
    ['ção', '_o'],
    ['  a.b/c  ', 'a_b_c'],
    ['x'.repeat(300), 'x'.repeat(256)],
    ['', ''],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeTagPart(input)).toBe(expected);
  });

  it('maps plain tags to category and name:value tags to their name; first one per name wins', () => {
    expect(toResendTags(['trip-invite', 'locale:pt-BR', 'second', 'locale:es', 'bad name:v@l', '***', ':x', 'k:'])).toEqual([
      { name: 'category', value: 'trip-invite' },
      { name: 'locale', value: 'pt-BR' },
      { name: 'bad_name', value: 'v_l' },
    ]);
  });

  it('gives no tags for none', () => {
    expect(toResendTags(undefined)).toEqual([]);
    expect(toResendTags([])).toEqual([]);
  });
});

describe('resendFrom', () => {
  it.each([
    [{ from: 'trips@holid.ai', fromName: 'Holid.ai' }, 'Holid.ai <trips@holid.ai>'],
    [{ from: 'trips@holid.ai', fromName: 'Holid.ai Viagens' }, 'Holid.ai Viagens <trips@holid.ai>'],
    [{ from: 'trips@holid.ai', fromName: 'Holid.ai, "Trips"' }, '"Holid.ai, \\"Trips\\"" <trips@holid.ai>'],
    [{ from: 'trips@holid.ai', fromName: 'Evil\r\nBcc: x@y.z' }, '"Evil Bcc: x@y.z" <trips@holid.ai>'],
    [{ from: 'onboarding@resend.dev', fromName: '' }, 'onboarding@resend.dev'],
  ])('formats %j', (sender, expected) => {
    expect(resendFrom(sender)).toBe(expected);
  });
});
