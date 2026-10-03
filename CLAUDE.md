# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product intent

This is a NestJS REST API that acts as the engine behind the holiday bot and handles holiday trips.
It's a travel management platform: it saves trip details and suggests nearby events during the trip.
Its input comes from `../telegram-bot`, a separate repo that talks to users over a chat provider.

**Current state vs. intent:** no trip or event features exist yet. The engine only accepts messages and queues them (see below).

## Commands

Requires **Node 24+**. Homebrew's `node@22` (22.12) fails inside the Nest CLI with `ERR_REQUIRE_CYCLE_MODULE`.

- `npm run start:dev`: run with watch mode. `npm run build` → `dist/`, `npm run start:prod` runs it.
- `npm test`: Jest (ESM mode, via `--experimental-vm-modules`). Single file: `npm test -- src/messages/messages.service.spec.ts`. Single test: add `-t "<name>"`.
- Needs Redis (`REDIS_HOST`/`REDIS_PORT`, default `localhost:6379`; see `.env.example`). `docker compose up redis` in `../telegram-bot` provides one.

## Architecture

- **NestJS 12 is ESM-only**, so this is an ESM TypeScript project (`"type": "module"`, `module: nodenext`). Relative imports must use the `.js` extension (`./app.module.js`) even in `.ts` files. Jest maps them back to `.ts` (`jest.config.js`).
- Tests are `*.spec.ts` next to the code. They use `@nestjs/testing`, and mocks are created with `jest` imported from `@jest/globals` (no global `jest` under ESM).
- TypeScript is pinned to 6.0: ts-jest and the Nest CLI don't support TypeScript 7 yet.
- `AppModule` sets up `ConfigModule` (global, reads `.env`) and the BullMQ Redis connection. Each feature is its own module under `src/<feature>/`.
- `messages` module: `POST /post-message` puts the JSON body on the `telegram` BullMQ queue (job name `telegramJob`) and returns `202 { jobId }`. `MessagesProcessor` is a placeholder that only logs jobs. `GET /` is a health check.
