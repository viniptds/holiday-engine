import { Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { AuthModule } from './auth.module.js';
import { DevAuthController } from './dev-auth.controller.js';
import { isDevLoginEnabled } from './dev-login.js';

/** DEV ONLY: the test login for clients that can't do Google sign-in (Expo Go). See `devLoginModule()`. */
@Module({
  imports: [AuthModule],
  controllers: [DevAuthController],
})
export class DevAuthModule implements OnModuleInit {
  onModuleInit() {
    new Logger(DevAuthModule.name).warn(
      'DEV_LOGIN_ENABLED: POST /app/v1/auth/dev signs anyone in with just an email. Never enable it in production.',
    );
  }
}

/**
 * Registers `DevAuthModule` (its route included) only when the dev login is enabled; otherwise
 * the route doesn't exist (404). Import it after `ConfigModule.forRoot()`, which loads `.env`.
 */
export const devLoginModule = () => ConditionalModule.registerWhen(DevAuthModule, isDevLoginEnabled, { debug: false });
