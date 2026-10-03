import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters, UsePipes } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthService } from './auth.service.js';
import type { AuthSession } from './auth.service.js';
import { GoogleSignInDto } from './dto/google-sign-in.dto.js';
import { RefreshTokenDto } from './dto/refresh-token.dto.js';

@Controller(`${APP_PREFIX}/auth`)
@UseFilters(AppExceptionFilter)
@UsePipes(appValidationPipe)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('google')
  @HttpCode(HttpStatus.OK)
  google(@Body() body: GoogleSignInDto): Promise<AuthSession> {
    return this.auth.signInWithGoogle(body.idToken);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshTokenDto): Promise<AuthSession> {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() body: RefreshTokenDto): Promise<void> {
    await this.auth.logout(body.refreshToken);
  }
}
