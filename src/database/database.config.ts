import { ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { Trip } from '../trips/trip.entity.js';
import { SuggestedEvent } from '../events/suggested-event.entity.js';
import { User } from '../users/user.entity.js';
import { RefreshToken } from '../auth/refresh-token.entity.js';
import { TripMember } from '../app-trips/trip-member.entity.js';
import { TripInvite } from '../members/trip-invite.entity.js';
import { TripRemoval } from '../members/trip-removal.entity.js';
import { AiConversation } from '../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../ai/entities/ai-message.entity.js';
import { TripPlace } from '../ai/entities/trip-place.entity.js';
import { UserEntitlement } from '../billing/user-entitlement.entity.js';
import { BillingEvent } from '../billing/billing-event.entity.js';
import { Moment } from '../moments/moment.entity.js';
import { UserAchievement } from '../achievements/user-achievement.entity.js';
import { migrations } from './migrations/index.js';

const isTrue = (value: string | undefined): boolean => value?.toLowerCase() === 'true';

// Entities and migrations are referenced as classes (not globs) so they load
// the same way from ts-jest, `nest start` and the compiled ESM build in dist/.
export function databaseConfig(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.get<string>('PGHOST', 'localhost'),
    port: Number(config.get<string>('PGPORT', '5432')),
    username: config.get<string>('PGUSER'),
    password: config.get<string>('PGPASSWORD'),
    database: config.get<string>('PGDATABASE'),
    ssl: isTrue(config.get<string>('PGSSL')) ? { rejectUnauthorized: false } : false,
    uuidExtension: 'pgcrypto',
    entities: [Trip, SuggestedEvent, User, RefreshToken, TripMember, TripInvite, TripRemoval, AiConversation, AiMessage, TripPlace, UserEntitlement, BillingEvent, Moment, UserAchievement],
    migrations,
    migrationsRun: true,
    synchronize: isTrue(config.get<string>('DB_SYNCHRONIZE')),
  };
}
