import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module.js';
import { RefreshToken } from './refresh-token.entity.js';
import { resolveJwtSecret } from './jwt-secret.js';
import { GoogleTokenVerifier } from './google-token-verifier.js';
import { AccessTokenService } from './access-token.service.js';
import { RefreshTokenService } from './refresh-token.service.js';
import { AuthService } from './auth.service.js';
import { AuthGuard } from './auth.guard.js';
import { AuthController } from './auth.controller.js';
import { MeController } from './me.controller.js';
import { assertDevLoginAllowed, DEV_LOGIN_NODE_ENVS, isDevLoginIgnored } from './dev-login.js';

const DEV_LOGIN_CHECK = Symbol('DEV_LOGIN_CHECK');

/**
 * Google sign-in, sessions and the `/me` profile. Exports `AuthGuard` (with what it needs, so a
 * module importing `AuthModule` can `@UseGuards(AuthGuard)`), and re-exports `UsersModule`
 * (`USER_DIRECTORY`, `UserDeletionHooks`, `UsersService`).
 */
@Module({
  imports: [
    ConfigModule,
    UsersModule,
    TypeOrmModule.forFeature([RefreshToken]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config.get<string>('JWT_SECRET'), config.get<string>('NODE_ENV')),
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    GoogleTokenVerifier,
    AccessTokenService,
    RefreshTokenService,
    AuthService,
    AuthGuard,
    {
      // Startup fails if the dev login (DevAuthModule) is switched on in production, and warns when it's ignored.
      provide: DEV_LOGIN_CHECK,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const env = { DEV_LOGIN_ENABLED: config.get<string>('DEV_LOGIN_ENABLED'), NODE_ENV: config.get<string>('NODE_ENV') };
        assertDevLoginAllowed(env);
        if (isDevLoginIgnored(env)) {
          new Logger(AuthModule.name).warn(
            `DEV_LOGIN_ENABLED=true is ignored: the dev login needs NODE_ENV=${DEV_LOGIN_NODE_ENVS.join(' or ')} ` +
              `(NODE_ENV is ${env.NODE_ENV ? `"${env.NODE_ENV}"` : 'unset'}).`,
          );
        }
      },
    },
  ],
  exports: [AuthGuard, AccessTokenService, AuthService, UsersModule],
})
export class AuthModule {}
