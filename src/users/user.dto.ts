import { User } from './user.entity.js';
import type { AvatarSource } from './user.entity.js';

/** Contract `User` JSON shape (docs/app-api-contract.md). */
export type UserDto = {
  id: string;
  email: string;
  displayName: string;
  /** Google's picture, a signed URL (1 h) for a custom one, or null (show the initial). */
  avatarUrl: string | null;
  avatarSource: AvatarSource;
  /** Whether "Use Google photo" can restore a Google picture. */
  hasGooglePicture: boolean;
  homeCity: string | null;
  createdAt: string;
};

/** `avatarUrl` comes from `UsersService.avatarUrlOf` (a custom picture needs signing). */
export function toUserDto(user: User, avatarUrl: string | null): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl,
    avatarSource: user.avatarSource ?? 'google',
    hasGooglePicture: !!user.googlePictureUrl,
    homeCity: user.homeCity ?? null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}
