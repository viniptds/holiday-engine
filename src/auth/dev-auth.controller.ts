import { Body, Controller, HttpCode, HttpStatus, Post, UseFilters, UsePipes } from '@nestjs/common';
import { APP_PREFIX } from '../app-common/auth-user.js';
import { AppExceptionFilter } from '../app-common/app-exception.filter.js';
import { appValidationPipe } from '../app-common/app-validation.pipe.js';
import { AuthService } from './auth.service.js';
import type { AuthSession } from './auth.service.js';
import { DevLoginDto } from './dto/dev-login.dto.js';

/** DEV ONLY (`DEV_LOGIN_ENABLED=true` with NODE_ENV development or test): only registered through `DevAuthModule`. */
@Controller(`${APP_PREFIX}/auth`)
@UseFilters(AppExceptionFilter)
@UsePipes(appValidationPipe)
export class DevAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('dev')
  @HttpCode(HttpStatus.OK)
  dev(@Body() body: DevLoginDto): Promise<AuthSession> {
    return this.auth.signInWithDevLogin(body.email, body.displayName);
  }
}
