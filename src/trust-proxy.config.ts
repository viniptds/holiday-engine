import { isIP } from 'node:net';

/**
 * Express `trust proxy` from TRUST_PROXY. Behind Cloudflare or a load balancer, `req.ip` (the key of the
 * public leads rate limits and other per-IP limits) is the proxy's address unless this is set.
 *
 * - unset / empty: off (undefined, nothing is applied)
 * - `true`: trust the first hop (1)
 * - an integer: that many hops
 * - a comma-separated list of addresses, CIDRs or Express keywords (`loopback,10.0.0.0/8`): passed through
 *
 * Anything else throws, so startup fails with the reason.
 */
export type TrustProxySetting = number | string | undefined;

const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

function validEntry(entry: string): boolean {
  if (KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const version = isIP(address ?? '');
  if (rest.length > 0 || version === 0) return false;
  if (prefix === undefined) return true;
  const max = version === 4 ? 32 : 128;
  return /^\d{1,3}$/.test(prefix) && Number(prefix) <= max;
}

export function trustProxySetting(value: string | undefined): TrustProxySetting {
  const raw = value?.trim() ?? '';
  if (raw === '') return undefined;
  if (raw.toLowerCase() === 'true') return 1;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (Number.isSafeInteger(hops)) return hops;
  } else {
    const entries = raw.split(',').map((entry) => entry.trim());
    if (entries.every(validEntry)) return entries.join(',');
  }
  throw new Error(
    `TRUST_PROXY must be empty (off), "true" (first hop), a number of hops, or a comma-separated list of addresses/CIDRs/loopback|linklocal|uniquelocal (got "${value}").`,
  );
}

/** Applies the setting to the Express app behind the Nest adapter (no-op when off). */
export function applyTrustProxy(app: { set(setting: string, value: unknown): unknown }, setting: TrustProxySetting): void {
  if (setting !== undefined) app.set('trust proxy', setting);
}
