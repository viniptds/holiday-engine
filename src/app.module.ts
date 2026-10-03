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
  ],
  controllers: [AppController],
})
export class AppModule {}
