# Engine deployment runbook

Stack: Cloudflare (DNS, proxy, WAF) -> Cloudflare Tunnel -> one Linux server running `docker-compose.prod.yml`
(postgres, redis, engine, cloudflared; no published ports). One engine replica only.

All commands run on the server, from the repo checkout (`holiday-engine/`), as the deploy user.

## 1. Server setup (Ubuntu 24.04)

1. Create a non-root user and give it SSH keys:
   `adduser deploy && usermod -aG sudo deploy`, then copy your public key to `~deploy/.ssh/authorized_keys`.
   Disable root and password SSH login in `/etc/ssh/sshd_config.d/`.
2. Install Docker Engine from Docker's apt repository (follow https://docs.docker.com/engine/install/ubuntu/,
   "Install using the apt repository"), then `sudo usermod -aG docker deploy` and log in again.
   Check: `docker compose version`.
3. Provider firewall: close every inbound port except SSH from your admin IP (or use the provider's browser SSH
   only). The tunnel is outbound-only, so 80/443 stay closed.
4. `sudo apt install unattended-upgrades` and `sudo dpkg-reconfigure -plow unattended-upgrades`.
5. 2 GB swap:
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile`
   and add `/swapfile none swap sw 0 0` to `/etc/fstab`.
6. Clone the repo and enter `holiday-engine/`. Then:
   `cp .env.production.example .env.production && chmod 600 .env.production`, and fill every blank value.
   `PGPASSWORD`: `openssl rand -base64 24`. `JWT_SECRET`: `openssl rand -base64 48`.
7. Backup cron at 03:30 UTC (`crontab -e`; set `CRON_TZ=UTC` above it):
   `30 3 * * * cd /srv/holidai/holiday-engine && ./deploy/backup.sh >> backups/backup.log 2>&1`
8. First deploy: `./deploy/deploy.sh`.

## 2. Cloudflare

1. Add the `holid.ai` zone to Cloudflare (Free plan) and switch the registrar's nameservers.
2. SSL/TLS: mode Full (strict); Edge Certificates: Always Use HTTPS on, Minimum TLS Version 1.2.
3. Security > Bots: Bot Fight Mode OFF. On the Free plan it cannot be skipped per path and would challenge the
   app's API calls and the RevenueCat webhook.
4. Zero Trust > Networks > Tunnels > Create tunnel (Cloudflared). Copy the token into `TUNNEL_TOKEN` in
   `.env.production`. Add the public hostname `api.holid.ai`, service type HTTP, URL `engine:3000`
   (that is `http://engine:3000`). Then `docker compose -f docker-compose.prod.yml --env-file .env.production up -d cloudflared`
   (or run `./deploy/deploy.sh`).

## 3. WAF custom rules and rate limiting

Security > WAF > Custom rules (the Free plan allows 5). Action Block for both. Use "Edit expression".

Rule 1, block everything on the API host except the health check and the app API (this also blocks the
unauthenticated bot ingress `POST /post-message`):

```
(http.host eq "api.holid.ai" and http.request.uri.path ne "/" and not starts_with(http.request.uri.path, "/app/v1/"))
```

Rule 2, defense in depth for the dev-only endpoints (they are also off in production):

```
(http.host eq "api.holid.ai" and (http.request.uri.path eq "/app/v1/auth/dev" or http.request.uri.path eq "/app/v1/subscription/dev-grant"))
```

Security > WAF > Rate limiting rules (Free: 1 rule). Per IP, period 10 s, action Block for 10 s, characteristic
IP. Pick a request limit that real sign-in traffic never reaches (for example 20 requests per 10 s). Expression
(path only):

```
starts_with(http.request.uri.path, "/app/v1/auth/")
```

Public, unauthenticated engine paths that stay reachable (everything else under `/app/v1/` needs a bearer token):
- `GET /` (health check, `{"status":"ok"}`)
- `POST /app/v1/auth/google`, `/auth/refresh`, `/auth/logout` (the dev login does not exist in production)
- `POST /app/v1/billing/revenuecat-webhook` (authenticated by the `REVENUECAT_WEBHOOK_AUTH` header)
- `/app/v1/email/unsubscribe` (link from emails)

The local-storage `/app/v1/files/:token` route is not served in production (S3 driver only). Test the rules with
`curl -i https://api.holid.ai/post-message -X POST` (expect 403) and `curl -i https://api.holid.ai/` (expect 200).

## 4. Cloudflare R2

1. R2 > Create bucket `holidai-moments`, private (no public access, no custom domain).
2. R2 > Manage API tokens > Create API token, permission Object Read & Write, restricted to that bucket. The engine
   needs PutObject, GetObject (also covers HeadObject and ranged GETs), DeleteObject on `moments/*` and `avatars/*`,
   and CopyObject (GetObject + PutObject). Put the key pair in `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`,
   the bucket in `S3_BUCKET`, and the account endpoint in `S3_ENDPOINT`.
3. Create a second private bucket `holidai-backups`. Settings > Object lifecycle rules > delete objects after 30 days.
4. A second API token, Object Write only (Object Read & Write if you want to test restores from it), restricted to the
   backup bucket. Put it in `BACKUP_S3_*` along with the bucket name and endpoint.
5. Moments uploads from the app are direct PUTs to presigned URLs. Add a CORS rule on the moments bucket only if the web
   app ever uploads (the mobile app does not need it).

## 5. Day-2 commands

Shortcut: `dc="docker compose -f docker-compose.prod.yml --env-file .env.production"`.

- Deploy: `git pull && ./deploy/deploy.sh` (backs up first, builds, waits up to 120 s for healthy, rolls the image back on failure).
- Status: `$dc ps`. Logs: `$dc logs -f --tail 100 engine`.
- Rollback to the previous image: `docker tag holidai-engine:previous holidai-engine:latest && $dc up -d --no-build engine`.
  A migration may already have run. If the old code cannot work with the new schema, restore the dump taken just before the deploy.
- Backup now: `./deploy/backup.sh` (dump in `./backups`, newest 14 kept, uploaded to R2 if configured).
- Restore: `./deploy/restore.sh --yes backups/holidai-<timestamp>.dump` (replaces the current data; stops and restarts the engine).
- Monthly restore drill: download a dump from the backup bucket, restore it on a scratch machine or a
  throwaway Compose project (`COMPOSE_PROJECT_NAME=drill`), check the engine becomes healthy and
  `select count(*) from users;` looks right, then `docker compose -p drill down -v`.
- Update Postgres or Redis minor versions: edit the tags in `docker-compose.prod.yml`, back up, then `./deploy/deploy.sh`.
