import { jest } from '@jest/globals';
import { QueryRunner, getMetadataArgsStorage } from 'typeorm';
import { CreateAiTables1760400000000 } from './1760400000000-create-ai-tables.js';
import { AddAiMessageAttempts1760400100000 } from './1760400100000-add-ai-message-attempts.js';
import { AddAiMessageReplyingUntil1760400200000 } from './1760400200000-add-ai-message-replying-until.js';
import { migrations } from './index.js';
import { AiConversation } from '../../ai/entities/ai-conversation.entity.js';
import { AiMessage } from '../../ai/entities/ai-message.entity.js';
import { TripPlace } from '../../ai/entities/trip-place.entity.js';
import { AddItinerary1760500000000 } from './1760500000000-add-itinerary.js';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

async function run(direction: 'up' | 'down', migration: { up: Function; down: Function } = new CreateAiTables1760400000000()): Promise<string[]> {
  const query = jest.fn(async (_sql: string) => undefined);
  await migration[direction]({ query } as unknown as QueryRunner);
  return query.mock.calls.map(([s]) => normalize(s));
}

describe('CreateAiTables1760400000000', () => {
  it('runs after the user foreign keys, in the range reserved for the AI branch', () => {
    const names = migrations.map((m) => m.name);
    expect(names.indexOf('CreateAiTables1760400000000')).toBeGreaterThan(names.indexOf('AddUserForeignKeys1760190000000'));
  });

  it('creates ai_conversations owned by users, linked to trips with SET NULL', async () => {
    const [create, ...rest] = await run('up');
    for (const part of [
      'CREATE TABLE "ai_conversations"',
      '"tripId" uuid,',
      '"title" varchar(100),',
      `CONSTRAINT "CHK_ai_conversations_status" CHECK ("status" IN ('open', 'confirmed', 'abandoned'))`,
      'CONSTRAINT "FK_ai_conversations_userId" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE',
      'CONSTRAINT "FK_ai_conversations_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE SET NULL',
    ]) {
      expect(create).toContain(part);
    }
    expect(rest).toContain('CREATE INDEX "IDX_ai_conversations_userId_updatedAt" ON "ai_conversations" ("userId", "updatedAt" DESC)');
  });

  it('creates ai_messages cascading with their conversation', async () => {
    const statements = await run('up');
    const create = statements.find((s) => s.startsWith('CREATE TABLE "ai_messages"'))!;
    for (const part of [
      '"text" text NOT NULL',
      '"draft" jsonb,',
      '"inputTokens" integer,',
      '"outputTokens" integer,',
      `CONSTRAINT "CHK_ai_messages_role" CHECK ("role" IN ('user', 'assistant'))`,
      'CONSTRAINT "FK_ai_messages_conversationId" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations" ("id") ON DELETE CASCADE',
    ]) {
      expect(create).toContain(part);
    }
    expect(statements).toContain('CREATE INDEX "IDX_ai_messages_conversationId_createdAt" ON "ai_messages" ("conversationId", "createdAt")');
  });

  it('creates trip_places, unique per trip and Google place, kept when the creator goes', async () => {
    const statements = await run('up');
    const create = statements.find((s) => s.startsWith('CREATE TABLE "trip_places"'))!;
    for (const part of [
      '"name" varchar(200) NOT NULL',
      '"day" smallint,',
      '"notes" varchar(500),',
      '"lat" double precision NOT NULL',
      '"rating" real,',
      `"types" text[] NOT NULL DEFAULT '{}'`,
      'CONSTRAINT "UQ_trip_places_tripId_googlePlaceId" UNIQUE ("tripId", "googlePlaceId")',
      'CONSTRAINT "CHK_trip_places_day" CHECK ("day" >= 1)',
      'CONSTRAINT "FK_trip_places_tripId" FOREIGN KEY ("tripId") REFERENCES "trips" ("id") ON DELETE CASCADE',
      'CONSTRAINT "FK_trip_places_createdBy" FOREIGN KEY ("createdBy") REFERENCES "users" ("id") ON DELETE SET NULL',
    ]) {
      expect(create).toContain(part);
    }
  });

  it('drops everything it created, in reverse order', async () => {
    expect(await run('down')).toEqual([
      'DROP TABLE "trip_places"',
      'DROP INDEX "IDX_ai_messages_conversationId_createdAt"',
      'DROP TABLE "ai_messages"',
      'DROP INDEX "IDX_ai_conversations_tripId"',
      'DROP INDEX "IDX_ai_conversations_userId_updatedAt"',
      'DROP TABLE "ai_conversations"',
    ]);
  });

  const entities: [string, Function, [string, string][]][] = [
    ['AiConversation', AiConversation, [['FK_ai_conversations_userId', 'CASCADE'], ['FK_ai_conversations_tripId', 'SET NULL']]],
    ['AiMessage', AiMessage, [['FK_ai_messages_conversationId', 'CASCADE']]],
    ['TripPlace', TripPlace, [['FK_trip_places_tripId', 'CASCADE'], ['FK_trip_places_createdBy', 'SET NULL']]],
  ];

  it.each(entities)('matches the %s entity checks, uniques, indexes and relations', async (_name, entity, relations) => {
    // Later migrations that add to these tables count too (AddItinerary: trip_places position/startTime).
    const sql = [
      ...(await run('up')),
      ...(await run('up', new AddAiMessageAttempts1760400100000())),
      ...(await run('up', new AddItinerary1760500000000())),
    ].join('\n');
    const storage = getMetadataArgsStorage();

    for (const check of storage.checks.filter((c) => c.target === entity)) {
      expect(sql).toContain(`CONSTRAINT "${check.name}" CHECK (${check.expression})`);
    }
    for (const unique of storage.uniques.filter((u) => u.target === entity)) {
      expect(sql).toContain(`CONSTRAINT "${unique.name}" UNIQUE (${(unique.columns as string[]).map((c) => `"${c}"`).join(', ')})`);
    }
    for (const index of storage.indices.filter((i) => i.target === entity)) {
      expect(sql).toContain(`CREATE INDEX "${index.name}"`);
    }
    for (const [name, onDelete] of relations) {
      const relation = storage.relations.find((r) => r.target === entity && storage.joinColumns.some(
        (j) => j.target === entity && j.propertyName === r.propertyName && j.foreignKeyConstraintName === name,
      ));
      expect(relation?.options.onDelete).toBe(onDelete);
      expect(sql).toContain(`CONSTRAINT "${name}" FOREIGN KEY`);
    }
  });
});

describe('AddAiMessageAttempts1760400100000', () => {
  it('runs right after the AI tables', () => {
    const names = migrations.map((m) => m.name);
    expect(names.indexOf('AddAiMessageAttempts1760400100000')).toBe(names.indexOf('CreateAiTables1760400000000') + 1);
  });

  it('adds attempts (at least 1, default 1) and removes it again', async () => {
    const migration = new AddAiMessageAttempts1760400100000();
    expect(await run('up', migration)).toEqual([
      'ALTER TABLE "ai_messages" ADD "attempts" smallint NOT NULL DEFAULT 1',
      'ALTER TABLE "ai_messages" ADD CONSTRAINT "CHK_ai_messages_attempts" CHECK ("attempts" >= 1)',
    ]);
    expect(await run('down', migration)).toEqual([
      'ALTER TABLE "ai_messages" DROP CONSTRAINT "CHK_ai_messages_attempts"',
      'ALTER TABLE "ai_messages" DROP COLUMN "attempts"',
    ]);
  });
});

describe('AddAiMessageReplyingUntil1760400200000', () => {
  it('runs right after the attempts migration', () => {
    const names = migrations.map((m) => m.name);
    expect(names.indexOf('AddAiMessageReplyingUntil1760400200000')).toBe(names.indexOf('AddAiMessageAttempts1760400100000') + 1);
  });

  it('adds a nullable replyingUntil and removes it again', async () => {
    const migration = new AddAiMessageReplyingUntil1760400200000();
    expect(await run('up', migration)).toEqual(['ALTER TABLE "ai_messages" ADD "replyingUntil" timestamptz']);
    expect(await run('down', migration)).toEqual(['ALTER TABLE "ai_messages" DROP COLUMN "replyingUntil"']);
  });
});
