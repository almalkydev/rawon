# Rawon V2 — Operations & Monitoring Runbook

## Health & Prometheus Endpoints

### Bot Process (`apps/bot`)

Controlled by `METRICS_HOST` (default `127.0.0.1`; `0.0.0.0` in Docker Compose) and `METRICS_PORT` (default `9090`):

- **`GET /healthz`** (or `/health`) — Returns HTTP `200` JSON:
  ```json
  {
    "status": "ok",
    "botsOnline": 1,
    "activeSessions": 0,
    "playingSessions": 0,
    "ffmpegProcesses": 0,
    "uptimeSeconds": 42,
    "rssBytes": 123456789
  }
  ```
- **`GET /metrics`** — Prometheus OpenMetrics / text exposition including:
  - `rawon_bots_online`
  - `rawon_active_sessions`
  - `rawon_playing_sessions`
  - `rawon_ffmpeg_processes`
  - `rawon_process_rss_bytes`
  - `rawon_process_heap_used_bytes`
  - `rawon_process_uptime_seconds`
  - `rawon_audio_cache_entries`
  - `rawon_audio_cache_bytes`
  - `rawon_audio_cache_hit_ratio`

### Background Worker (`apps/worker`)

Controlled by `METRICS_HOST` and `WORKER_HEALTH_PORT` (default `9091`):

- **`GET /healthz`** — Reports `activePrefetches`, `pendingPrefetches`, and `cacheStats`.

## Operational Procedures

### 1. Multi-Bot Assignment & Failover

- Configure comma-separated tokens in `DISCORD_TOKEN=tokenA,tokenB,tokenC`.
- Each bot publishes a Redis heartbeat every 5s.
- Prefix commands route through the deterministically elected sticky primary bot per guild so duplicate replies never occur.
- Joining multiple voice channels in the same server automatically allocates an idle secondary bot while acquiring an atomic Lua Redis lock on `(guildId, voiceChannelId)`.
- If a secondary or primary bot drops, remaining bots detect expired heartbeats and take over future requests seamlessly.

### 2. YouTube Bot Verification & Age-Restricted Media

If yt-dlp reports bot verification or age restriction:
- Use `/login start` (developer-only) with remote Chromium DevTools (`DEVTOOLS_PORT`) to refresh Google cookies encrypted on disk via `COOKIES_ENCRYPTION_KEY`.
- Rawon V2 automatically updates its `YtDlpClient` cookie jar & `visitorData` upon login completion.

### 3. Cache Maintenance & Cleanup

- `DiskAudioCache` automatically enforces both `AUDIO_CACHE_MAX_MB` and `AUDIO_CACHE_MAX_FILES` limits using LRU eviction while protecting currently pinned playback files.
- `apps/worker` runs a 5-minute periodic sweep (`evictIfNeeded()`) alongside background `precache_request` jobs.

### 4. Graceful Shutdown

Sending `SIGINT` or `SIGTERM`:
1. Stops background `yt-dlp` auto-updaters and cancels queued prefetches.
2. Flushes final track position snapshots (`updateQueuePosition`) for all active sessions.
3. Stops active FFmpeg processes via `ProcessSupervisor` and clears Discord voice channel statuses.
4. Closes HTTP health server, Redis connections, and PostgreSQL pool cleanly (15s forced exit safety timer).
