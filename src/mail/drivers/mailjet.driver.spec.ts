import { jest } from '@jest/globals';
import { MAILJET_SEND_URL, MailjetMailTransport } from './mailjet.driver.js';

const sender = { from: 'trips@holid.ai', fromName: 'Holid.ai', replyTo: 'hello@holid.ai' };
const credentials = { apiKey: 'public-key', apiSecret: 'very-secret' };
const message = { to: 'ana@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', tags: ['trip-invite'] };

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const success = { Messages: [{ Status: 'success', To: [{ Email: 'ana@example.com', MessageUUID: 'uuid-1', MessageID: 1152921500 }] }] };

function mailjet(response: Response | Error) {
  const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return { fetchFn, transport: new MailjetMailTransport(credentials, sender, fetchFn as typeof fetch) };
}

describe('MailjetMailTransport', () => {
  it('posts one message to the v3.1 Send API with Basic auth', async () => {
    const { fetchFn, transport } = mailjet(jsonResponse(200, success));

    await expect(transport.send(message)).resolves.toEqual({ id: '1152921500' });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(MAILJET_SEND_URL);
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('public-key:very-secret').toString('base64')}`);
    expect(headers['content-type']).toBe('application/json');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({
      Messages: [
        {
          From: { Email: 'trips@holid.ai', Name: 'Holid.ai' },
          To: [{ Email: 'ana@example.com' }],
          Subject: 'Hi',
          TextPart: 'Hello',
          HTMLPart: '<p>Hello</p>',
          ReplyTo: { Email: 'hello@holid.ai' },
          CustomCampaign: 'trip-invite',
        },
      ],
    });
  });

  it('leaves out ReplyTo and CustomCampaign when there are none', async () => {
    const fetchFn = jest.fn(async (_url: string | URL | Request, _init?: RequestInit) => jsonResponse(200, success));
    const transport = new MailjetMailTransport(credentials, { ...sender, replyTo: undefined }, fetchFn as typeof fetch);

    await transport.send({ ...message, tags: undefined });

    const [payload] = JSON.parse(fetchFn.mock.calls[0][1]?.body as string).Messages;
    expect(payload).not.toHaveProperty('ReplyTo');
    expect(payload).not.toHaveProperty('CustomCampaign');
  });

  it.each([
    [400, { Messages: [{ Status: 'error', Errors: [{ ErrorCode: 'mj-0013', ErrorMessage: '"ana@example.com" is an invalid email address.' }] }] }, 'HTTP 400: "[recipient]" is an invalid email address.'],
    [401, { ErrorInfo: '', ErrorMessage: 'API key authentication/authorization failure. You may be unauthorized to access the API or your API key may be expired. Visit API keys management section to check your keys.', StatusCode: 401 }, 'HTTP 401: API key authentication'],
  ])('rejects a %i with the provider message and no secret', async (status, body, expected) => {
    const { transport } = mailjet(jsonResponse(status, body));

    const error = (await transport.send(message).catch((e: Error) => e)) as Error;

    expect(error.message).toContain(`Mailjet send failed with ${expected}`);
    expect(error.message).not.toContain('very-secret');
    expect(error.message).not.toContain('ana@example.com');
  });

  it('rejects a 5xx without a JSON body', async () => {
    const { transport } = mailjet(new Response('<html>Bad gateway</html>', { status: 502 }));

    await expect(transport.send(message)).rejects.toThrow('Mailjet send failed with HTTP 502: no details');
  });

  it('rejects a 200 whose message was not accepted', async () => {
    const { transport } = mailjet(jsonResponse(200, { Messages: [{ Status: 'error', Errors: [{ ErrorMessage: 'Blocked' }] }] }));

    await expect(transport.send(message)).rejects.toThrow('Mailjet did not accept the message (status error): Blocked');
  });

  it("cancels the HTTP request when the caller's signal aborts", async () => {
    const fetchFn = jest.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const transport = new MailjetMailTransport(credentials, sender, fetchFn as typeof fetch);
    const controller = new AbortController();

    const pending = transport.send(message, controller.signal);
    controller.abort(new Error('timed out after 15000 ms'));

    await expect(pending).rejects.toThrow('timed out after 15000 ms');
    expect(fetchFn.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('passes on network errors', async () => {
    const { transport } = mailjet(new Error('fetch failed'));

    await expect(transport.send(message)).rejects.toThrow('fetch failed');
  });
});
