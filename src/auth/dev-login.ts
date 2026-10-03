type Env = Record<string, string | undefined>;

const isTrue = (value: string | undefined) => value?.trim().toLowerCase() === 'true';

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

/** Whether `POST /app/v1/auth/dev` is registered: DEV_LOGIN_ENABLED=true and not production. */
export const isDevLoginEnabled = (env: Env): boolean => isTrue(env.DEV_LOGIN_ENABLED) && env.NODE_ENV !== 'production';
