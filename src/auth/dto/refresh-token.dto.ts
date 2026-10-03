import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Body of `POST /auth/refresh` and `POST /auth/logout`. */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  refreshToken: string;
}
