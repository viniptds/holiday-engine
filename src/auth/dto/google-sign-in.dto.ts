import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class GoogleSignInDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  idToken: string;
}
