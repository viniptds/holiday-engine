/** TEST ONLY: `appDb()` plus `leads`, and a testing module wiring `LeadsModule` (and optionally AuthModule). */
import { randomUUID } from 'node:crypto';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { appDb } from '../../testing/app-db.js';
import { appTestingModule } from '../../testing/app-testing.js';
import type { InMemoryDb } from '../../testing/in-memory-db.js';
import { User } from '../../users/user.entity.js';
import { Lead } from '../lead.entity.js';
import { LeadsModule } from '../leads.module.js';

export const WEB_ORIGIN = 'https://holid.ai';
export const LEADS_ENV = {
  WEB_ORIGINS: `${WEB_ORIGIN},https://holidai.pages.dev,http://localhost:5173`,
  LEADS_TOKEN_SECRET: 'leads-token-secret-that-is-at-least-32-chars',
  LEADS_HASH_SALT: 'leads-hash-salt-16+',
};

export function leadsDb(): InMemoryDb {
  // The email is stored lowercased, so a plain unique key behaves like the lower("email") index.
  return appDb().define(Lead, {
    primary: ['id'],
    unique: [['email']],
    generate: () => ({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), status: 'new', convertedUserId: null }),
    updateDate: 'updatedAt',
    relations: { convertedUser: { entity: User, column: 'convertedUserId' } },
  });
}

export function leadsTestingModule(db: InMemoryDb, imports: unknown[] = [], config: Record<string, string> = LEADS_ENV): TestingModuleBuilder {
  return appTestingModule(db, [LeadsModule, ...imports], config).overrideProvider(getRepositoryToken(Lead)).useValue(db.repository(Lead as never));
}
