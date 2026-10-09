/** Notification settings (`.env.example`). Errors name settings, never values. */
export type NotificationsConfig = {
  pushProvider: 'expo' | 'log';
  expoAccessToken: string | undefined;
  /** Local hour (0-23) countdowns go out at. */
  sendHour: number;
  /** The engine's public base URL (unsubscribe links), without a trailing slash. */
  publicUrl: string;
};

export const NOTIFICATIONS_CONFIG = Symbol('NOTIFICATIONS_CONFIG');
type Env = Record<string, string | undefined>;
const value = (env: Env, key: string) => env[key]?.trim() || undefined;

export function readNotificationsConfig(env: Env): NotificationsConfig {
  const provider = (value(env, 'PUSH_PROVIDER') ?? 'log').toLowerCase();
  if (provider !== 'expo' && provider !== 'log') throw new Error(`Unknown PUSH_PROVIDER "${provider}". Use one of: expo, log.`);
  if (provider === 'log' && value(env, 'NODE_ENV') === 'production') throw new Error('PUSH_PROVIDER=log is not allowed in production');
  const hourRaw = value(env, 'NOTIFICATIONS_SEND_HOUR') ?? '9';
  const sendHour = Number(hourRaw);
  if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) throw new Error(`NOTIFICATIONS_SEND_HOUR must be a whole hour from 0 to 23 (got "${hourRaw}")`);
  const publicUrl = (value(env, 'ENGINE_PUBLIC_URL') ?? `http://localhost:${value(env, 'PORT') ?? '3000'}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new Error('ENGINE_PUBLIC_URL must be an http(s) URL');
  if (value(env, 'NODE_ENV') === 'production' && !value(env, 'ENGINE_PUBLIC_URL')) throw new Error('ENGINE_PUBLIC_URL is required in production (email unsubscribe links)');
  return { pushProvider: provider, expoAccessToken: value(env, 'EXPO_ACCESS_TOKEN'), sendHour, publicUrl };
}

export const NOTIFICATIONS_ENV_KEYS = ['NODE_ENV', 'PORT', 'PUSH_PROVIDER', 'EXPO_ACCESS_TOKEN', 'NOTIFICATIONS_SEND_HOUR', 'ENGINE_PUBLIC_URL'];
