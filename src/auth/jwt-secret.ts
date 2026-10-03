import { randomBytes } from 'node:crypto';

export const JWT_SECRET_MIN_LENGTH = 32;

/**
 * The access-token signing secret from `JWT_SECRET`. Startup fails when it's missing or shorter than
 * 32 characters, except under `NODE_ENV=test`, where a random per-process secret stands in.
 */
export function resolveJwtSecret(secret: string | undefined, nodeEnv: string | undefined): string {
  if (secret && secret.length >= JWT_SECRET_MIN_LENGTH) return secret;
  if (nodeEnv === 'test') return secret || randomBytes(32).toString('base64url');
  throw new Error(
    `JWT_SECRET must be set to at least ${JWT_SECRET_MIN_LENGTH} characters (e.g. \`openssl rand -base64 48\`).`,
  );
}
