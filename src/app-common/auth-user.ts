/** Route prefix of the app API; the bot's queue endpoints stay unprefixed. */
export const APP_PREFIX = 'app/v1';

/** The signed-in app user, as attached to the request by the auth guard. */
export interface AuthUser {
  id: string;
  email: string;
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
