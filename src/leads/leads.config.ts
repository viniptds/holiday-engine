export const LEADS_CONFIG = Symbol('LEADS_CONFIG');
export const PUBLIC_PREFIX = 'public/v1';
export const TOKEN_SECRET_MIN_LENGTH = 32;
export const HASH_SALT_MIN_LENGTH = 16;

export type LeadsConfig = {
  /** Allowed site origins (`https://holid.ai`), normalized: lowercase, no trailing slash. Empty = lead capture closed. */
  origins: string[];
  tokenSecret: string;
  hashSalt: string;
};

type Settings = { WEB_ORIGINS?: string; LEADS_TOKEN_SECRET?: string; LEADS_HASH_SALT?: string };

/** `https://Holid.ai/` and `https://holid.ai` are the same origin. Anything that isn't an http(s) origin is rejected. */
export function normalizeOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Reads `WEB_ORIGINS`, `LEADS_TOKEN_SECRET` and `LEADS_HASH_SALT`. With no `WEB_ORIGINS` the public
 * endpoints refuse every origin; with it, startup fails unless both secrets are long enough (the
 * message names settings, never values).
 */
export function readLeadsConfig(env: Settings): LeadsConfig {
  const raw = (env.WEB_ORIGINS ?? '').trim();
  const tokenSecret = env.LEADS_TOKEN_SECRET ?? '';
  const hashSalt = env.LEADS_HASH_SALT ?? '';
  if (!raw) return { origins: [], tokenSecret, hashSalt };

  const problems: string[] = [];
  const origins: string[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const origin = normalizeOrigin(part);
    if (origin) origins.push(origin);
    else problems.push('WEB_ORIGINS has an entry that is not an http(s) origin');
  }
  if (tokenSecret.length < TOKEN_SECRET_MIN_LENGTH) problems.push(`LEADS_TOKEN_SECRET must be at least ${TOKEN_SECRET_MIN_LENGTH} characters when WEB_ORIGINS is set`);
  if (hashSalt.length < HASH_SALT_MIN_LENGTH) problems.push(`LEADS_HASH_SALT must be at least ${HASH_SALT_MIN_LENGTH} characters when WEB_ORIGINS is set`);
  if (problems.length) throw new Error(`Invalid lead capture settings: ${[...new Set(problems)].join('; ')}.`);
  return { origins: [...new Set(origins)], tokenSecret, hashSalt };
}

/** The matched allowed origin of a request (`Origin`, else the `Referer`'s origin), or null. */
export function allowedOrigin(config: LeadsConfig, origin: string | undefined, referer: string | undefined): string | null {
  const candidate = origin?.trim() ? normalizeOrigin(origin) : referer?.trim() ? normalizeOrigin(referer) : null;
  return candidate && config.origins.includes(candidate) ? candidate : null;
}
