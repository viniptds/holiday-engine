import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { USER_DIRECTORY } from '../app-common/auth-user.js';
import { User } from './user.entity.js';
import { UsersService } from './users.service.js';
import { UserDeletionHooks } from './user-deletion-hooks.js';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService, UserDeletionHooks, { provide: USER_DIRECTORY, useExisting: UsersService }],
  exports: [UsersService, UserDeletionHooks, USER_DIRECTORY],
})
export class UsersModule {}
