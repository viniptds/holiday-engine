# holiday-engine

NestJS engine for the Holid.ai app (`/app/v1`) and the Telegram bot queues. Developer notes: `CLAUDE.md` and `docs/repo-map.md`.

## Deploy

Production runs as a Docker Compose stack (postgres, redis, engine, cloudflared) behind a Cloudflare Tunnel.
Files: `Dockerfile`, `docker-compose.prod.yml`, `.env.production.example`, `deploy/`.
Step-by-step server, Cloudflare and R2 setup, deploys, rollbacks and backups: [`deploy/RUNBOOK.md`](deploy/RUNBOOK.md).
