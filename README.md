# holiday-engine

NestJS engine for the Holid.ai app (`/app/v1`) and the Telegram bot queues. Developer notes: `CLAUDE.md` and `docs/repo-map.md`.

## Deploy

Primary path: Coolify on one VPS behind a Cloudflare Tunnel (Postgres and Redis as Coolify databases, the engine as a
Dockerfile application): [`deploy/COOLIFY.md`](deploy/COOLIFY.md). The API is served at `https://holidai.waygex.com/app/v1`.

Alternative: a plain Docker Compose stack (postgres, redis, engine, cloudflared; `docker-compose.prod.yml`,
`.env.production.example`, `deploy/`): [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).
