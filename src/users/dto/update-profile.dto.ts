import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { Trim } from '../../trips/dto/trim.transform.js';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';

/** `PATCH /me` body. Omitted fields are unchanged; `homeCity: null` clears it, `displayName` can't be null. */
export class UpdateProfileDto {
  // Like @IsOptional(), but only for an omitted field: `null` is still validated (and rejected).
  @ValidateIf((_, value) => value !== undefined)
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoControlChars()
  displayName?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @NoControlChars()
  homeCity?: string | null;
}
