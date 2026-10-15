import { Module, OnModuleInit } from '@nestjs/common';
import type { MiddlewareConsumer, NestModule } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity.js';
import { UsersModule } from '../users/users.module.js';
import { GoogleSignInHooks } from '../users/google-sign-in-hooks.js';
import { Lead } from './lead.entity.js';
import { LeadsController } from './leads.controller.js';
import { LEADS_CONFIG, PUBLIC_PREFIX, readLeadsConfig } from './leads.config.js';
import { LeadsService } from './leads.service.js';
import { LeadsTokenService } from './leads-token.service.js';
import { PublicCorsMiddleware } from './public-cors.middleware.js';

/**
 * Landing-page lead capture (docs/web-leads-spec.md): the public `/public/v1/leads` endpoints, CORS for
 * `/public/v1/*`, and the sign-in hook that marks a lead `converted`. Startup fails when `WEB_ORIGINS`
 * is set without long enough `LEADS_TOKEN_SECRET` and `LEADS_HASH_SALT`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Lead, User]), UsersModule],
  controllers: [LeadsController],
  providers: [
    {
      provide: LEADS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        readLeadsConfig({
          WEB_ORIGINS: config.get<string>('WEB_ORIGINS'),
          LEADS_TOKEN_SECRET: config.get<string>('LEADS_TOKEN_SECRET'),
          LEADS_HASH_SALT: config.get<string>('LEADS_HASH_SALT'),
        }),
    },
    LeadsTokenService,
    LeadsService,
    PublicCorsMiddleware,
  ],
})
export class LeadsModule implements NestModule, OnModuleInit {
  constructor(
    private readonly leads: LeadsService,
    private readonly signInHooks: GoogleSignInHooks,
  ) {}

  onModuleInit(): void {
    this.signInHooks.register((user) => this.leads.convert(user));
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(PublicCorsMiddleware).forRoutes({ path: `${PUBLIC_PREFIX}/{*path}`, method: RequestMethod.ALL });
  }
}
