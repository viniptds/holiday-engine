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
- `main.ts` sets the HTTP server's `keepAliveTimeout` from `HTTP_KEEP_ALIVE_TIMEOUT_MS` (default 65000, above common load-balancer idle timeouts; BUG-023) and `headersTimeout` to that + 1000; an invalid value fails startup (`http-server.config.ts`).
- `AppModule` sets up `ConfigModule` (global, reads `.env`), the BullMQ Redis connection, TypeORM, and `ScheduleModule`. Each feature is its own module under `src/<feature>/`.

**There is no HTTP API for trips.** Everything goes through queues:

`POST /post-message` (`messages`): validates the envelope (`400` if bad) → queue `telegram` → `MessagesProcessor` → `MessagesRouter.route()` → `TripsService` / `EventsService` → `OutboundPublisher` → queue `bot-outbound` (`outbound`), which the bot consumes. Every request gets exactly one reply, the result or an `error` (`VALIDATION`, `NOT_FOUND`, `INTERNAL`). Handler errors never fail the job; only a failure to publish the reply does. `GET /` is a health check.

- `trips`: `Trip` entity, owner-scoped `TripsService`. A chat is `(provider, chatId)`, and another chat's trip behaves as not found. `chatId` is text (Telegram ids exceed int32). The engine sends structured data only; the bot owns all wording.
- Payload DTOs (`trips/dto/`) are validated in the router with `plainToInstance` + `validate({ whitelist: true })`. The service assumes validated input.
- `events`: the `EventsProvider` interface is selected by `EVENTS_PROVIDER` (only `mock` for now; it's deterministic per city and day). `EventsService.suggestForRequest` / `suggestScheduled`. `suggested_events` dedupes scheduled sends. Days are UTC.
- `suggestions`: `SuggestionsScheduler` runs on `SUGGESTIONS_CRON` (UTC, default `0 9 * * *`), registered at runtime through `SchedulerRegistry` with `CronJob` from `cron` (a transitive dependency of `@nestjs/schedule`). Each trip is isolated, so one failure doesn't stop the others.
- `ai`: AI trip planning (`../docs/app-ai-spec.md`). `AiService` holds conversations (author-only: anyone else gets NOT_FOUND), turns, rate limits and confirm. `llm/` has the `LlmProvider` interface with Anthropic (Messages API) and OpenAI (Chat Completions), both over plain `fetch`: no SDKs, by the user's decision. `places/` checks draft places with Google Places Text Search (also `fetch`). Selected by env: `AI_PROVIDER` (`anthropic`|`openai`|`mock`), `AI_MODEL`, `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, `ANTHROPIC_WORKSPACE_ID` (optional; sent as `anthropic-workspace-id`, for keys not scoped to a workspace), `AI_TIMEOUT_MS`, `AI_MAX_TOKENS`, `AI_EFFORT` (empty: not sent), `AI_FALLBACKS` (`default`|`off`), `PLACES_PROVIDER` (`google`|`mock`), `GOOGLE_PLACES_API_KEY`. The mock providers are deterministic and offline: the default, and for tests (never real API calls in tests: mocked `fetch`). Startup fails on a missing key or a mock in production. Rate limits count `attempts` on user messages under `pg_advisory_xact_lock`. Logs carry ids, provider, model, token counts and latency only: never message text, names or emails.
- Itinerary (`../docs/app-itinerary-spec.md`): `ItineraryService` (in `ai/`) owns `/trips/:id/places` (list with `itineraryVersion`, search, add, patch, delete) and `PUT /trips/:id/itinerary`. Every itinerary change (add, delete, PUT, AI accept, a date change through `TripScheduleHooks`) runs in one transaction with the trip row locked (`FOR UPDATE`) and bumps `trips.itineraryVersion`; never write that column from a trip loaded without the lock. Adds re-fetch Place Details (`PlacesDirectory.details`, minimal field mask), enforce 50 km from the destination centre and 200 places per trip; searches are limited to 60 per user per hour (in memory, per process).
- `database`: config is built from the `PG*` env vars. **Entities and migrations are listed as classes** (`database.config.ts`, `migrations/index.ts`), not globs, so a new migration must be added to that index. `migrationsRun: true` applies them on startup. `DB_SYNCHRONIZE` stays false outside throwaway local databases.

## Email

- `src/mail/`: a provider-neutral `MailTransport` (`send({ to, subject, text, html, replyTo?, tags? })`, injected with `MAIL_TRANSPORT`). `MAIL_PROVIDER` picks the driver at startup: `log` (default, sends nothing; subject at info, body at debug with links replaced by `[link]`), `smtp` (nodemailer; Mailjet's relay, SendGrid, SES...) or `mailjet` (HTTP Send API v3.1 via `fetch`). Settings are in `.env.example`; a missing one fails startup with the list of missing keys.
- Adding a provider: one file in `src/mail/drivers/` exporting a `MailDriver` (required settings + factory) and one entry in `MAIL_DRIVERS` (`mail.config.ts`).
- Templates are plain TypeScript in `src/mail/templates/` (HTML + text, `en`, `pt-BR`, `es`); escape every interpolated value with `escapeHtml` and pass names through `singleLine`. Subjects are fixed per locale (no user text). Invite emails go out in the inviter's `Accept-Language` (`@RequestLocale()`).
- `POST /trips/:id/invites` answers `201` once the invite exists; the email is sent in the background (15 s overall timeout) and a failure is logged at warn. Email invites are rate limited from `trip_invites` rows (20 per inviter per 24 h, 1 per trip and recipient per 10 min) → `429 RATE_LIMITED` with `Retry-After`; link invites aren't.
- `MAIL_VERIFY_ON_BOOT=true` checks the SMTP connection at startup (boot fails if it can't connect).
- Never log secrets or message bodies at info level, never the invitee's address at info (log invite/trip/message ids), and never invite links or tokens at any level (`src/mail/redact.ts`). Tests never send real email: the drivers take a fake nodemailer transport or `fetch`.

## Billing (Holid.ai Plus)

- `src/billing/` (`../docs/app-subscriptions-spec.md`): `user_entitlements` is the source of truth for "is Plus" (`BillingService.isPlus`: `active` or `grace`, and no expiry or one in the future). Store purchases only, through RevenueCat; no SDK on the engine (REST over plain `fetch`).
- `POST /app/v1/billing/revenuecat-webhook`: `Authorization` must equal `REVENUECAT_WEBHOOK_AUTH` (constant-time, never logged). Idempotent on the event id (`billing_events`); unknown app user ids are ignored; out-of-order events never move `expiresAt` back. After an event, the subscriber is re-read from RevenueCat REST (the truth); a REST failure keeps the event data. Writes run under a per-user advisory lock.
- `POST /app/v1/subscription/sync` (20/user/hour, `503 BILLING_UNAVAILABLE` on a RevenueCat outage). `BILLING_PROVIDER=revenuecat|mock` (default mock; mock in production fails startup; mock reads only the local table). `POST /app/v1/subscription/dev-grant` exists only under the dev-login rules.
- Free AI quota: `FREE_AI_MESSAGES_PER_DAY` user-message rows per local day (`X-Timezone`, stored in `users.timezone`; DST-safe midnight in `app-common/timezone.ts`), checked in the AI per-user lock transaction → `402 PAYMENT_REQUIRED` / `AI_QUOTA_EXCEEDED` with `resetsAt`. Retries of a failed reply don't count. Place limit: the trip OWNER's plan (`FREE_TRIP_PLACES_LIMIT` or 200) → `402` / `TRIP_PLACES_PLUS_REQUIRED` with `limit`; existing places are never touched. `/me` adds `plan`, `aiQuota`, `limits` through `MeExtensions`.
