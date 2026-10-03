import { jest } from '@jest/globals';
import { SmtpMailTransport } from './smtp.driver.js';
import type { SmtpOptions, SmtpTransporter } from './smtp.driver.js';

const sender = { from: 'trips@holid.ai', fromName: 'Holid.ai', replyTo: 'hello@holid.ai' };
const options: SmtpOptions = { host: 'in-v3.mailjet.com', port: 587, secure: false, auth: { user: 'key', pass: 'secret' } };
const message = { to: 'ana@example.com', subject: 'Hi', text: 'Hello', html: '<p>Hello</p>', tags: ['trip-invite'] };

function fakeTransporter() {
  const transporter = {
    verify: jest.fn(async (): Promise<unknown> => true),
    sendMail: jest.fn(async (_mail: Record<string, unknown>) => ({ messageId: '<abc@holid.ai>' })),
  };
  const create = jest.fn((_options: SmtpOptions): SmtpTransporter => transporter);
  return { transporter, create };
}

describe('SmtpMailTransport', () => {
  it('builds the nodemailer transport from the SMTP settings without connecting', () => {
    const { transporter, create } = fakeTransporter();

    new SmtpMailTransport(options, sender, create);

    expect(create).toHaveBeenCalledWith(options);
    expect(transporter.verify).not.toHaveBeenCalled();
  });

  it('checks the connection on the first send only, then sends from MAIL_FROM', async () => {
    const { transporter, create } = fakeTransporter();
    const smtp = new SmtpMailTransport(options, sender, create);

    await expect(smtp.send(message)).resolves.toEqual({ id: '<abc@holid.ai>' });
    await smtp.send(message);

    expect(transporter.verify).toHaveBeenCalledTimes(1);
    expect(transporter.sendMail).toHaveBeenCalledWith({
      from: { name: 'Holid.ai', address: 'trips@holid.ai' },
      to: 'ana@example.com',
      subject: 'Hi',
      text: 'Hello',
      html: '<p>Hello</p>',
      replyTo: 'hello@holid.ai',
    });
  });

  it("uses the message's reply-to over MAIL_REPLY_TO, and none when neither is set", async () => {
    const { transporter, create } = fakeTransporter();

    await new SmtpMailTransport(options, sender, create).send({ ...message, replyTo: 'ana@x.org' });
    await new SmtpMailTransport(options, { ...sender, replyTo: undefined }, create).send(message);

    expect(transporter.sendMail.mock.calls[0][0]).toMatchObject({ replyTo: 'ana@x.org' });
    expect(transporter.sendMail.mock.calls[1][0]).not.toHaveProperty('replyTo');
  });

  it('fails the send when the server is unreachable, and checks again next time', async () => {
    const { transporter, create } = fakeTransporter();
    transporter.verify.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:587'));
    const smtp = new SmtpMailTransport(options, sender, create);

    await expect(smtp.send(message)).rejects.toThrow('SMTP connection check failed: connect ECONNREFUSED 127.0.0.1:587');
    expect(transporter.sendMail).not.toHaveBeenCalled();
    await expect(smtp.send(message)).resolves.toEqual({ id: '<abc@holid.ai>' });
    expect(transporter.verify).toHaveBeenCalledTimes(2);
  });

  it('stops waiting when the signal aborts (nodemailer cannot cancel), and ignores the late result', async () => {
    const { transporter, create } = fakeTransporter();
    let finish!: () => void;
    transporter.sendMail.mockImplementationOnce(() => new Promise((resolve) => (finish = () => resolve({ messageId: '<late>' }))));
    const controller = new AbortController();

    const pending = new SmtpMailTransport(options, sender, create).send(message, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('timed out after 15000 ms'));

    await expect(pending).rejects.toThrow('timed out after 15000 ms');
    finish();
  });

  it('does not start a send for an already aborted signal', async () => {
    const { transporter, create } = fakeTransporter();

    await expect(new SmtpMailTransport(options, sender, create).send(message, AbortSignal.abort(new Error('gone')))).rejects.toThrow('gone');
    expect(transporter.sendMail).not.toHaveBeenCalled();
  });

  it('passes on a rejected message', async () => {
    const { transporter, create } = fakeTransporter();
    transporter.sendMail.mockRejectedValueOnce(new Error('550 Sender not authorized'));

    await expect(new SmtpMailTransport(options, sender, create).send(message)).rejects.toThrow('550 Sender not authorized');
  });
});
