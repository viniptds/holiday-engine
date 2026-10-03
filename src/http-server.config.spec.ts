import { createServer } from 'node:http';
import { applyHttpServerTimeouts, DEFAULT_KEEP_ALIVE_TIMEOUT_MS, httpServerTimeouts } from './http-server.config.js';

describe('httpServerTimeouts (HTTP_KEEP_ALIVE_TIMEOUT_MS)', () => {
  it('defaults to 65 s keep-alive and headers 1 s longer', () => {
    expect(DEFAULT_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
    expect(httpServerTimeouts(undefined)).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000 });
    expect(httpServerTimeouts('  ')).toEqual({ keepAliveTimeout: 65_000, headersTimeout: 66_000 });
  });

  it('reads a whole number of milliseconds', () => {
    expect(httpServerTimeouts('75000')).toEqual({ keepAliveTimeout: 75_000, headersTimeout: 76_000 });
    expect(httpServerTimeouts(' 1000 ')).toEqual({ keepAliveTimeout: 1_000, headersTimeout: 2_000 });
  });

  it.each(['abc', '65s', '-1', '0', '999', '1.5e4', '6.5', '1e400', '0x10000'])('fails startup on %p', (value) => {
    expect(() => httpServerTimeouts(value)).toThrow(
      `HTTP_KEEP_ALIVE_TIMEOUT_MS must be a whole number of milliseconds, at least 1000 (got "${value}").`,
    );
  });

  it('sets both timeouts on a Node HTTP server', () => {
    const server = createServer();

    applyHttpServerTimeouts(server, httpServerTimeouts('70000'));

    expect(server.keepAliveTimeout).toBe(70_000);
    expect(server.headersTimeout).toBe(71_000);
    server.close();
  });
});
