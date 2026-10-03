/**
 * HTTP keep-alive settings (BUG-023). Node closes idle keep-alive connections after 5 s by default;
 * a load balancer or proxy with a longer idle timeout (AWS ALB 60 s, many ingresses 60-75 s) can then
 * reuse a socket the server is closing, and the client sees ECONNRESET or a 502. The server's timeout
 * must be longer than theirs, and headersTimeout a little longer still.
 */
export const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HEADERS_TIMEOUT_MARGIN_MS = 1_000;

export type HttpServerTimeouts = { keepAliveTimeout: number; headersTimeout: number };

/**
 * From HTTP_KEEP_ALIVE_TIMEOUT_MS: a whole number of milliseconds, at least 1000 (unset or empty:
 * 65000). Anything else throws, so startup fails with the reason.
 */
export function httpServerTimeouts(value: string | undefined): HttpServerTimeouts {
  const raw = value?.trim() ?? '';
  const keepAliveTimeout = raw === '' ? DEFAULT_KEEP_ALIVE_TIMEOUT_MS : Number(raw);
  if (!/^\d*$/.test(raw) || !Number.isSafeInteger(keepAliveTimeout) || keepAliveTimeout < 1_000) {
    throw new Error(`HTTP_KEEP_ALIVE_TIMEOUT_MS must be a whole number of milliseconds, at least 1000 (got "${value}").`);
  }
  return { keepAliveTimeout, headersTimeout: keepAliveTimeout + HEADERS_TIMEOUT_MARGIN_MS };
}

/** Applies the timeouts to the Node HTTP server. */
export function applyHttpServerTimeouts(server: HttpServerTimeouts, timeouts: HttpServerTimeouts): void {
  server.keepAliveTimeout = timeouts.keepAliveTimeout;
  server.headersTimeout = timeouts.headersTimeout;
}
