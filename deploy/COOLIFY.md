# Deploy the engine with Coolify

One VPS runs Coolify. A Cloudflare Tunnel is the only way in. Layout:

- `https://holidai.waygex.com/` goes to holiday-web, `https://holidai.waygex.com/app/v1/*` goes to this engine.
- `https://coolify.waygex.com` is the Coolify dashboard, behind Cloudflare Access.
- Postgres 16 and Redis are Coolify database resources. The engine and web are Coolify applications built from Git.

Anything marked **check in the UI** was not verified against the live Coolify UI. The Coolify docs are at https://coolify.io/docs.
The plain-Compose alternative is [`RUNBOOK.md`](RUNBOOK.md) (also holds the WAF rules and R2 details used below).

## 1. Server and Coolify

1. Ubuntu 24.04 LTS, at least 2 CPU / 2 GB RAM / 10 GB disk (Coolify's minimum), US-East. Any provider.
2. Create a non-root sudo user with your SSH key, disable root and password SSH login (see RUNBOOK section 1, step 1).
3. Provider firewall: all inbound closed except SSH from your IP. The tunnel is outbound-only.
4. `sudo apt install unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades`
5. Swap (2 GB):
   `sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile && echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab`
6. Install Coolify (official script, run as root; it installs Docker too). The script takes a version as its first
   argument, so pin the current 4.x release (4.4.6 on 2026-10-16; check https://github.com/coollabsio/coolify/releases):
   `curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash -s 4.4.6`
7. Open `http://<server-ip>:8000` once (temporarily allow port 8000 from your IP), create the admin account.
   Then Settings > Updates > Automatic updates: **Enabled** (keep it on).

## 2. Cloudflare

1. Add `waygex.com` to Cloudflare (Free plan), switch the registrar's nameservers, wait until the zone is Active.
2. SSL/TLS mode **Full (strict)**; Edge Certificates: **Always Use HTTPS** on, **Minimum TLS Version 1.2**.
   The free Universal certificate covers `holidai.waygex.com` and `coolify.waygex.com` (one level).
3. Security > Bots: **Bot Fight Mode OFF**. On Free it cannot be skipped per path and would challenge the app's API
   calls and the RevenueCat webhook.
4. Tunnel (https://coolify.io/docs/knowledge-base/cloudflare/tunnels/all-resource):
   Cloudflare dashboard > Networking > Tunnels > Create tunnel, choose Docker, copy the token (starts with `eyJ`).
   In Coolify: project > **+ New** > search "Cloudflared" > Environment Variables > paste the token > Deploy.
   Back in Cloudflare click Continue. (Alternative: install cloudflared directly on the host. Check in the UI which
   one reaches `localhost:80`; the Coolify guide uses `http://localhost:80`, use `http://127.0.0.1:80` if it fails on IPv6.)
5. Tunnel > Configure > Routes > Add route > Published Application, two routes, path empty:
   - `holidai.waygex.com` -> `http://localhost:80` (Coolify's proxy, Traefik)
   - `coolify.waygex.com` -> `http://localhost:8000` (dashboard)
   If a DNS record already exists for a hostname, delete it or add a proxied CNAME to `<tunnel-id>.cfargotunnel.com`.
6. Dashboard login protection (https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/):
   Zero Trust > Access controls > Applications > Create new application > Self-hosted and private > public hostname
   `coolify.waygex.com` > policy **Allow**, rule Emails = your email only > identity providers One-time PIN (and Google
   if configured) > Create.
7. Test: open `https://coolify.waygex.com`, you must see the Access login first. If the dashboard loads but live
   updates or the terminal fail, the realtime ports (6001/6002) are not routed. Fallback: in Coolify Settings set the
   instance domain to `https://coolify.waygex.com` and point that tunnel route at `http://localhost:80` (check in the UI).
8. Close ports now: remove 8000 (and 80, 443, 6001, 6002 if opened) from the provider firewall. Only SSH stays.
   Do not let Coolify force HTTP to HTTPS (redirect loop): on each application's Domains section set
   **Redirect HTTP to HTTPS** to Disabled (the Coolify tunnel guide's caveat).

## 3. R2 buckets

As RUNBOOK section 4:
1. Private bucket `holidai-moments` + token Object Read & Write limited to it (goes into `S3_*` env vars).
2. Private bucket `holidai-backups` + a second token (Object Read & Write, so restores can read it) limited to it.
   Add an object lifecycle rule to delete after 30 days (this is the S3-side retention; Coolify's own setting is
   only for local copies).
3. Coolify > **S3 Storage** (sidebar) > **New storage**: name `r2-backups`, bucket `holidai-backups`, region `auto`,
   endpoint split into protocol `https` and host `<account-id>.r2.cloudflarestorage.com`, the backup token's keys >
   **Validate Connection & Continue** (https://coolify.io/docs/core/s3-storage/overview).

## 4. Postgres and Redis

Create both in a Coolify project/environment (same server and destination network as the applications).
Keep **Public access** off for both.

1. **+ New > Database > PostgreSQL**. Image: pin `postgres:16.14-alpine` (as in the Compose file). Set name,
   user, password, database `holiday`. Copy the internal host name (a container-like id) from the connection URL.
   Start it.
2. Backups (https://coolify.io/docs/databases/backups): database > **Backups** > add a schedule, frequency daily
   (`0 3 * * *`), open the schedule > S3 storage > select `r2-backups` > **Enable S3** > Save. Retention: set local
   **Days to keep** to 14 and optionally Local copy = **Delete after S3 upload**. Click **Backup now** once and
   confirm the file appears in the bucket.
3. Restore (https://coolify.io/docs/databases/restore): stop the engine, take a fresh backup, then on the running
   target database open **Import Backup**, pick the S3 storage, enter the file path inside the bucket, **Check file**,
   start, follow the output. "Replace objects that already exist" is off by default; turn it on to overwrite
   existing tables. Start the engine again.
4. **+ New > Database > Redis**. Image: pin `redis:8.10.2-alpine` (as in the Compose file; the Coolify default is `redis:7.2`).
   Under **General > Custom Redis configuration** put:
   ```
   appendonly yes
   maxmemory-policy noeviction
   requirepass ""
   ```
   `noeviction` is required for BullMQ. The password line is the workaround for the gap below.
   Start it and note the internal host name.

**Redis password gap.** The engine can only be told `REDIS_HOST` and `REDIS_PORT` (`src/app.module.ts`, BullMQ
`connection: { host, port }`). It cannot send a password or a username. Coolify generates a password for every Redis
resource, so the engine would fail with NOAUTH. Workaround used here: Redis is not published and sits on the
private Docker network, with `requirepass ""` in the custom config (Coolify only adds its own password when the file
has no `requirepass`; check in the UI that the resource still starts and that its health check passes, a
healthcheck warning about the unused password is harmless). Proper fix, an engine change not done here: read
`REDIS_PASSWORD` (and optionally `REDIS_USERNAME`) in that `connection` object and pass it along.

## 5. Engine application

1. Project > **+ New > Application** > private repository (GitHub App or Deploy Key) > the holiday-engine repo,
   branch `main` (or your release branch). Build pack **Dockerfile** (`/Dockerfile`).
2. General: Ports Exposes `3000`. Domains: `https://holidai.waygex.com/app/v1` (domain plus path).
   Prefix stripping must be OFF, the engine serves `/app/v1/...` itself: Coolify strips the path prefix by default, so
   open **Advanced > Proxy > Path prefixes** and choose **Keep paths as-is**
   (https://coolify.io/docs/knowledge-base/domains; check the exact wording in the UI).
   Redirect HTTP to HTTPS: Disabled (see section 2, step 8).
3. Health check: enabled, path `/`, port 3000, method GET (the engine answers `{"status":"ok"}`; this runs inside the
   server and is never routed from the internet). The image also has its own HEALTHCHECK.
4. Environment Variables (runtime; mark secrets as such). Start from `.env.production.example`, with these on top:
   ```
   NODE_ENV=production
   PORT=3000
   HTTP_KEEP_ALIVE_TIMEOUT_MS=120000
   PGHOST=<postgres internal host>
   PGPORT=5432
   PGUSER=<from the Postgres resource>
   PGPASSWORD=<from the Postgres resource>
   PGDATABASE=holiday
   PGSSL=false
   REDIS_HOST=<redis internal host>
   REDIS_PORT=6379
   ENGINE_PUBLIC_URL=https://holidai.waygex.com
   APP_INVITE_BASE_URL=https://holidai.waygex.com
   ```
   Fill the rest as in `.env.production.example` (`JWT_SECRET`: `openssl rand -base64 48`, Google client ids, Resend,
   Anthropic, Places, RevenueCat, `S3_*` for the moments bucket). Skip `TUNNEL_TOKEN` and `BACKUP_*`.
5. One instance only (do not scale replicas: rate limits and cron are per process).
6. Before a deploy that contains a migration (they run on boot): Postgres > Backups > **Backup now**. Then **Deploy**.
   Watch the deployment log until the health check passes.

## 6. Web application

See holiday-web's README. Short version: Dockerfile build pack, port 80, domain `https://holidai.waygex.com`, build
variables `VITE_SITE_URL=https://holidai.waygex.com` (and the others), health check path `/healthz`, Redirect HTTP to
HTTPS Disabled. Coolify routes the more specific `/app/v1` to the engine and everything else to the web.

## 7. Checks

```
curl -i https://holidai.waygex.com/                        # 200, the web app
curl -i https://holidai.waygex.com/pt                      # 301, Location: /pt/
curl -i https://holidai.waygex.com/app/v1/me               # 401 JSON from the engine
curl -i -X POST https://holidai.waygex.com/post-message    # 404 from nginx, never an engine reply
curl -i https://coolify.waygex.com                         # redirects to the Cloudflare Access login
```
Then add the WAF custom rule (dev routes) and the rate-limit rule from RUNBOOK section 3 (host `holidai.waygex.com`).

## 8. Day-2

- Deploy: push to the tracked branch (enable the webhook/auto deploy), or the **Redeploy** button. Back up first when
  migrations are included.
- Logs: application > **Logs** (and **Deployments** for build logs). Database logs the same way.
- Rollback: application > **Deployments** > pick the previous successful one > **Rollback**/redeploy (Coolify keeps
  previous images; check in the UI). If a migration already ran and the old code cannot use the new schema, restore the
  backup taken before the deploy (section 4, step 3).
- Backups: daily to R2 (check the schedule's execution list weekly). Monthly restore drill: create a throwaway
  Postgres resource, Import Backup from the S3 storage, check `select count(*) from users;`, delete the resource.
- Coolify itself updates automatically; check the release notes after upgrades.
