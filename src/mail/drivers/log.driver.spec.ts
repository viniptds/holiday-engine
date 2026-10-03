import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import { LogMailTransport } from './log.driver.js';

describe('LogMailTransport', () => {
  it('logs the subject at info and the body at debug, never the recipient or a link', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    const body = 'Open invite: https://holid.ai/invite/SECRET-TOKEN\nIn the app: holidai://invite/SECRET-TOKEN';

    await expect(
      new LogMailTransport({ from: '', fromName: 'Holid.ai' }).send({
        to: 'ana@example.com',
        subject: 'Ana invited you',
        text: body,
        html: `<a href="https://holid.ai/invite/SECRET-TOKEN">Open</a>`,
        tags: ['trip-invite'],
      }),
    ).resolves.toEqual({});

    const info = JSON.stringify(log.mock.calls);
    const details = JSON.stringify(debug.mock.calls);
    expect(info).toContain('Ana invited you');
    expect(info).toContain('trip-invite');
    expect(info).not.toContain('Open invite');
    expect(details).toContain('Open invite: [link]');
    for (const logs of [info, details]) {
      expect(logs).not.toContain('ana@example.com');
      expect(logs).not.toContain('SECRET-TOKEN');
    }
    log.mockRestore();
    debug.mockRestore();
  });
});
