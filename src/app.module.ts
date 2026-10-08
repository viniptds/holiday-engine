import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { MessagesModule } from './messages/messages.module.js';
import { TripsModule } from './trips/trips.module.js';
import { EventsModule } from './events/events.module.js';
import { SuggestionsModule } from './suggestions/suggestions.module.js';
import { UsersModule } from './users/users.module.js';
import { AuthModule } from './auth/auth.module.js';
import { devLoginModule } from './auth/dev-auth.module.js';
import { AppTripsModule } from './app-trips/app-trips.module.js';
import { MembersModule } from './members/members.module.js';
import { AiModule } from './ai/ai.module.js';
import { BillingModule } from './billing/billing.module.js';
import { devBillingModule } from './billing/dev-billing.module.js';
import { databaseConfig } from './database/database.config.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: Number(config.get<string>('REDIS_PORT', '6379')),
        },
      }),
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: databaseConfig,
    }),
    ScheduleModule.forRoot(),
    MessagesModule,
    TripsModule,
    EventsModule,
    SuggestionsModule,
    UsersModule,
    AuthModule,
    // DEV ONLY: POST /app/v1/auth/dev, registered only with DEV_LOGIN_ENABLED=true outside production.
    devLoginModule(),
    AppTripsModule,
    MembersModule,
    AiModule,
    BillingModule,
    // DEV ONLY: POST /app/v1/subscription/dev-grant, under the dev-login rules.
    devBillingModule(),
  ],
  controllers: [AppController],
})
export class AppModule {}
