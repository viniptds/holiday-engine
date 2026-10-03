import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsOptional, MaxLength } from 'class-validator';
import { INVITE_ROLES } from '../members.types.js';
import type { InviteRole } from '../members.types.js';

/** `POST /trips/:id/invites` body. Without an email it's a link invite; the role defaults to editor. */
export class CreateInviteDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(254)
  @IsEmail()
  email?: string;

  // Owners invite as editor or viewer too; ownership only moves by transfer.
  @IsOptional()
  @IsIn(INVITE_ROLES, { message: 'role must be editor or viewer' })
  role?: InviteRole;
}
