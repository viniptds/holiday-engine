import { User } from './user.entity.js';

/** Contract `User` JSON shape (docs/app-api-contract.md). */
export type UserDto = {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  homeCity: string | null;
  createdAt: string;
};

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl ?? null,
    homeCity: user.homeCity ?? null,
    createdAt: new Date(user.createdAt).toISOString(),
  };
}
