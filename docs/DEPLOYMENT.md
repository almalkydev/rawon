# Rawon V2 — Deployment Guide

## Prerequisites

- **Docker Engine + Docker Compose v2** (recommended), or:
- **Node.js >= 22 LTS** (Node 24 recommended; `node:sqlite` is used by legacy V1 `.db` imports), **pnpm >= 8**, **FFmpeg**, **yt-dlp** (`python3` optional), **PostgreSQL >= 15**, and **Redis >= 7**.

## 1. Docker Compose Deployment (Recommended)

1. Configure environment variables:

```bash
cp .env.example .env
```

Edit `.env`:
- `DISCORD_TOKEN`: Single bot token or comma-separated tokens (`token1,token2,...`) for multi-bot support.
- `POSTGRES_PASSWORD`: Change `change_me_strong_password` to a strong secret.
- `DEVS`: Comma-separated Discord user IDs for developer commands (`/eval`, `/setup`, `/login`, `/db-export`, `/db-import`).
- Optional integrations: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `STEGRIPE_API_LYRICS_TOKEN`, `COOKIES_ENCRYPTION_KEY`.

2. Build and start services (`postgres`, `redis`, `bot`, `worker`):

```bash
docker compose up -d --build
```

3. Verify service health:

```bash
docker compose ps
curl -fsS http://127.0.0.1:9090/healthz
```

4. Optional Prometheus scraping profile (`http://127.0.0.1:9095`):

```bash
docker compose --profile monitoring up -d
```

To build with Chromium installed for the `/login` YouTube cookie workflow inside containers, set build arg `INSTALL_CHROMIUM=true` in `docker-compose.yml` or pass `--build-arg INSTALL_CHROMIUM=true`.

## 2. Dokploy Deployment (Docker Compose Stack)

1. In Dokploy, click **Create Service -> Compose**.
2. Set Source Provider to GitHub/Git using repository `https://github.com/almalkydev/rawon`, branch `main`, and **Compose Path** `docker-compose.yml`.
3. In the Dokploy **Environment** tab, configure your required secrets (Compose injects them cleanly via `${VAR}` without requiring a manual `.env` file on disk):
   - `DISCORD_TOKEN` — single token or comma-separated tokens (`token1,token2,...`)
   - `POSTGRES_PASSWORD` — strong PostgreSQL password
   - `DEVS` — comma-separated developer Discord user IDs
   - Optional: `MAIN_PREFIX`, `LOCALE`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `STEGRIPE_API_LYRICS_TOKEN`, `COOKIES_ENCRYPTION_KEY`, `BOT_METRICS_PORT` (defaults to `127.0.0.1:9090`)
4. Deploy the stack. `postgres`, `redis`, `bot`, and `worker` start with built-in healthchecks, automatic SQL migrations (`001_initial.sql`), and persistent named volumes (`rawon_pgdata`, `rawon_redisdata`, `rawon_cache`, `rawon_data`).
5. Ensure **Message Content Intent** is enabled in the Discord Developer Portal (see [docs/DISCORD_INTENTS.md](DISCORD_INTENTS.md)).

## 3. Bare-Metal / Node.js Deployment

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm start
# Optionally run background cache prefetch worker in a second process:
pnpm start:worker
```

Note: PostgreSQL schema migrations in `packages/database/migrations/001_initial.sql` also execute automatically on startup when `DATABASE_URL` is configured.

## 4. Migrating Data from Rawon V1

### Option A: From V1 SQLite (`data.db`)

Run inside an environment with access to the V1 SQLite file:

```bash
node packages/database/dist/migrate-cli.js --sqlite /path/to/data.db
```

### Option B: Via `/db-export` / `/db-import` Commands

Run `/db-import` as a configured `DEVS` user, attaching a V1 (`1.0.0`) or V2 (`2.0.0`) JSON snapshot file or providing an HTTPS URL (protected by public-IP SSRF validation).

## 5. Resource Sizing Guidelines

- **`postgres`**: 512 MB RAM limit (`postgres:17-alpine`)
- **`redis`**: 300 MB RAM (`allkeys-lru` 256 MB cap + AOF persistence)
- **`bot`**: 1.5 GB RAM / 2.0 vCPU default limit (scales linearly when spawning parallel FFmpeg transcodes; Opus passthrough streams require minimal CPU)
- **`worker`**: 768 MB RAM / 1.0 vCPU default limit (`WORKER_CONCURRENCY=2` by default)
