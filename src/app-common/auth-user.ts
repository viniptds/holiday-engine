/** Route prefix of the app API; the bot's queue endpoints stay unprefixed. */
export const APP_PREFIX = 'app/v1';

/** The signed-in app user, as attached to the request by the auth guard. */
export interface AuthUser {
  id: string;
  email: string;
  /**
   * Created by the dev login (Google `sub` `dev:<email>`), so `email` is unverified: it never
   * satisfies an email-invite match. Always set by `AuthGuard`.
   */
  devAccount?: boolean;
  /** The IANA zone stored for the user (`users.timezone`), if any. */
  timezone?: string | null;
  /** The language stored for the user (`users.locale`), if any. */
  locale?: string | null;
}

/** Public profile of a user, as other features need it (member lists, invites). */
export interface UserProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Looks up user profiles by id. Implemented by the users module; injected with `USER_DIRECTORY`. */
export interface UserDirectory {
  getProfiles(ids: string[]): Promise<Map<string, UserProfile>>;
}

export const USER_DIRECTORY = Symbol('USER_DIRECTORY');
