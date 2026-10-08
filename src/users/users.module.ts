import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TimezoneInterceptor } from './timezone.interceptor.js';
import { MeExtensions } from './me-extensions.js';
import { TypeOrmModule } from '@nestjs/typeorm';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';
import { UserDeletionHooks } from './user-deletion-hooks.js';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [
    UsersService,
    UserDeletionHooks,
    MeExtensions,
    { provide: USER_DIRECTORY, useExisting: UsersService },
    // Every authenticated request: keep users.timezone in step with X-Timezone.
    { provide: APP_INTERCEPTOR, useClass: TimezoneInterceptor },
  ],
  exports: [UsersService, UserDeletionHooks, MeExtensions, USER_DIRECTORY],
})
export class UsersModule {}
