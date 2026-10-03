type Env = Record<string, string | undefined>;

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

/** Environments where the dev login may run. Anything else, including an unset NODE_ENV, counts as not dev. */
export const DEV_LOGIN_NODE_ENVS = ['development', 'test'];

/**
 * DEV ONLY. Fails startup when the dev login is switched on in production: it signs anyone in
 * with just an email.
 */
export function assertDevLoginAllowed(env: Env): void {
  if (isTrue(env.DEV_LOGIN_ENABLED) && env.NODE_ENV === 'production') {
    throw new Error(
      'DEV_LOGIN_ENABLED=true is not allowed with NODE_ENV=production: POST /app/v1/auth/dev would sign anyone in ' +
        'with just an email. Remove DEV_LOGIN_ENABLED (or set it to false).',
    );
  }
}

/**
 * Whether `POST /app/v1/auth/dev` is registered: DEV_LOGIN_ENABLED=true and NODE_ENV is
 * `development` or `test`. Fails closed: an unset or unknown NODE_ENV (e.g. `staging`) keeps it off.
 */
export const isDevLoginEnabled = (env: Env): boolean =>
  isTrue(env.DEV_LOGIN_ENABLED) && DEV_LOGIN_NODE_ENVS.includes(env.NODE_ENV ?? '');

/** DEV_LOGIN_ENABLED=true but ignored because NODE_ENV isn't a dev environment (and isn't production either). */
export const isDevLoginIgnored = (env: Env): boolean =>
  isTrue(env.DEV_LOGIN_ENABLED) && !isDevLoginEnabled(env) && env.NODE_ENV !== 'production';

/** Accounts created by the dev login have Google `sub` `dev:<email>` (the email is not verified). */
export const DEV_LOGIN_SUB_PREFIX = 'dev:';
export const isDevLoginAccount = (googleSub: string): boolean => googleSub.startsWith(DEV_LOGIN_SUB_PREFIX);
