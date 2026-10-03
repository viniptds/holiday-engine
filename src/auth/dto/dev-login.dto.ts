import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Trim } from '../../trips/dto/trim.transform.js';
import { NoControlChars } from '../../trips/dto/no-control-chars.validator.js';

/** `POST /auth/dev` body (dev only). Decorators run bottom-up, so the type check is listed last. */
export class DevLoginDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @MaxLength(320)
  @IsEmail()
  email: string;

  @IsOptional()
  @Trim()
  @NoControlChars()
  @MaxLength(60)
  @IsNotEmpty()
  @IsString()
  displayName?: string;
}
