# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product intent

This is a NestJS engine behind the holiday bot. It's a travel management platform: it saves trip details and suggests nearby events during the trip.
Its input comes from `../telegram-bot`, a separate repo that talks to users over a chat provider.

**The bot ↔ engine contract lives in `../docs/trip-engine-contract.md`** (message types, payloads, limits). Change it there first, then on both sides.

## Commands

Requires **Node 24+**. Homebrew's `node@22` (22.12) fails inside the Nest CLI with `ERR_REQUIRE_CYCLE_MODULE` (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`).

- `npm run start:dev`: run with watch mode. `npm run build` → `dist/`, `npm run start:prod` runs it.
- `npm test`: Jest (ESM mode, via `--experimental-vm-modules`). Single file: `npm test -- src/messages/messages.router.spec.ts`. Single test: add `-t "<name>"`.
- `npm run typecheck`: `tsc --noEmit`. ts-jest runs with `isolatedModules`, so **type errors in specs don't fail `npm test`**. Run both.
- Needs Redis and Postgres (see `.env.example`). `docker compose up -d redis postgres` in `../telegram-bot` provides both (Postgres user/password `holiday`, database `holiday_engine`, on `localhost:5432`). Don't start the compose `bot` service at the same time as a local bot: two pollers on one token conflict.

## Architecture

- **NestJS 12 is ESM-only**, so this is an ESM TypeScript project (`"type": "module"`, `module: nodenext`). Relative imports must use the `.js` extension (`./app.module.js`) even in `.ts` files. Jest maps them back to `.ts` (`jest.config.js`).
- Tests are `*.spec.ts` next to the code. They use `@nestjs/testing`, and mocks are created with `jest` imported from `@jest/globals` (no global `jest` under ESM). `*.feature.spec.ts` wire real modules with stubbed queues and repositories.
- With `isolatedModules` + `emitDecoratorMetadata`, interfaces and types used in a decorated constructor must be imported with `import type`.
- TypeScript is pinned to 6.0: ts-jest and the Nest CLI don't support TypeScript 7 yet.
- `AppModule` sets up `ConfigModule` (global, reads `.env`), the BullMQ Redis connection, TypeORM, and `ScheduleModule`. Each feature is its own module under `src/<feature>/`.

**There is no HTTP API for trips.** Everything goes through queues:

`POST /post-message` (`messages`): validates the envelope (`400` if bad) → queue `telegram` → `MessagesProcessor` → `MessagesRouter.route()` → `TripsService` / `EventsService` → `OutboundPublisher` → queue `bot-outbound` (`outbound`), which the bot consumes. Every request gets exactly one reply, the result or an `error` (`VALIDATION`, `NOT_FOUND`, `INTERNAL`). Handler errors never fail the job; only a failure to publish the reply does. `GET /` is a health check.

- `trips`: `Trip` entity, owner-scoped `TripsService`. A chat is `(provider, chatId)`, and another chat's trip behaves as not found. `chatId` is text (Telegram ids exceed int32). The engine sends structured data only; the bot owns all wording.
- Payload DTOs (`trips/dto/`) are validated in the router with `plainToInstance` + `validate({ whitelist: true })`. The service assumes validated input.
- `events`: the `EventsProvider` interface is selected by `EVENTS_PROVIDER` (only `mock` for now; it's deterministic per city and day). `EventsService.suggestForRequest` / `suggestScheduled`. `suggested_events` dedupes scheduled sends. Days are UTC.
- `suggestions`: `SuggestionsScheduler` runs on `SUGGESTIONS_CRON` (UTC, default `0 9 * * *`), registered at runtime through `SchedulerRegistry` with `CronJob` from `cron` (a transitive dependency of `@nestjs/schedule`). Each trip is isolated, so one failure doesn't stop the others.
- `ai`: AI trip planning (`../docs/app-ai-spec.md`). `AiService` holds conversations (author-only: anyone else gets NOT_FOUND), turns, rate limits and confirm. `llm/` has the `LlmProvider` interface with Anthropic (Messages API) and OpenAI (Chat Completions), both over plain `fetch`: no SDKs, by the user's decision. `places/` checks draft places with Google Places Text Search (also `fetch`). Selected by env: `AI_PROVIDER` (`anthropic`|`openai`|`mock`), `AI_MODEL`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `AI_TIMEOUT_MS`, `AI_MAX_TOKENS`, `AI_EFFORT` (empty: not sent), `AI_FALLBACKS` (`default`|`off`), `PLACES_PROVIDER` (`google`|`mock`), `GOOGLE_PLACES_API_KEY`. The mock providers are deterministic and offline: the default, and for tests (never real API calls in tests: mocked `fetch`). Startup fails on a missing key or a mock in production. Rate limits count `attempts` on user messages under `pg_advisory_xact_lock`. Logs carry ids, provider, model, token counts and latency only: never message text, names or emails.
- `database`: config is built from the `PG*` env vars. **Entities and migrations are listed as classes** (`database.config.ts`, `migrations/index.ts`), not globs, so a new migration must be added to that index. `migrationsRun: true` applies them on startup. `DB_SYNCHRONIZE` stays false outside throwaway local databases.
