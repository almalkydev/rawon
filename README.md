# Rawon V2

Production-grade TypeScript rewrite of the **Rawon** Discord music platform (`rawon-v2`), preserving 100% of V1 user-facing command, multi-bot, localization, and request-channel parity while rebuilding the internals around a modular audio pipeline, PostgreSQL + Redis state coordination, strict Discord Components V2 UI, and Docker Compose deployment.

## Key Improvements Over V1

- **Zero-FFmpeg Opus Passthrough + High-Fidelity Transcoding (`@rawon/audio-engine`)**: Demuxes compatible 48 kHz stereo WebM/Ogg Opus streams directly into Discord Opus packets with zero child FFmpeg processes; uses single-pass FFmpeg with fast input `-ss` seeking, 19 DSP presets, 15-band EQ, EBU R128 loudness normalization, and soft peak limiting (`alimiter`) when DSP/seeking/transcoding is requested.
- **Resilient Media Providers & Caching (`@rawon/providers`, `@rawon/cache`)**: Supports YouTube, YouTube Music, SoundCloud, direct audio links, Discord message attachments, and legitimate Spotify metadata resolution mapped to authorized playback sources, backed by Redis metadata caching, atomic LRU disk audio caching with playback pinning, and bounded background prefetching (`apps/worker`).
- **PostgreSQL & Redis Coordination (`@rawon/database`)**: Atomic Lua voice-channel ownership locks, deterministic sticky primary-bot election with automatic failover, sliding-window rate limiting, database-backed migrations (`node:sqlite` V1 `.db` and V1/V2 JSON snapshot support via `/db-export`, `/db-import`, and `pnpm db:migrate`).
- **Modern Discord Interface (`@rawon/discord`)**: Pure Discord Components V2 persistent Hydra request-channel player, interactive control buttons, modals, paginated queue/lyrics viewers, autocomplete, Message Context Menu (`Play with Rawon`), 31 slash & prefix commands across 14 locales.
- **Process Supervision & Security (`@rawon/shared`)**: SSRF public-URL validation with DNS rebinding protection, AES-GCM encrypted cookie storage, secret redaction in logs/`/eval`, `/healthz` and Prometheus `/metrics` endpoints, and guaranteed FFmpeg subprocess cleanup on abort/skip/shutdown.

## Monorepo Architecture

```text
packages/
  shared/        -> Errors, SSRF guard, operation queue, formatting, Pino logger
  config/        -> Zod env loader, settings defaults, 14-locale I18nService
  queue/         -> TrackQueue (OFF/QUEUE/SONG loops, shuffle, history) & AutoplayPlanner
  cache/         -> MemoryLruCache, RedisMetadataCache, DiskAudioCache, PrefetchCoordinator
  providers/     -> yt-dlp client, YouTube/SoundCloud/Spotify/Direct HTTP, Stegripe/LrcLib lyrics
  audio-engine/  -> Codec prober, DSP filter builder, ProcessSupervisor, AudioPipeline
  database/      -> PostgreSQL + Memory stores, Redis Lua coordinator, V1 SQLite/JSON MigrationBridge
  music-core/    -> Decoupled GuildMusicSession, SessionManager, VoiceTransport interface
  discord/       -> 31 commands, RequestChannelService, Components V2 UI, MultiBotSupervisor
apps/
  bot/           -> Main Discord multi-bot entrypoint + /healthz & /metrics HTTP server
  worker/        -> Background audio prefetch & cache eviction worker
```

## Quick Start

1. Copy `.env.example` to `.env` and set `DISCORD_TOKEN` (single token or comma-separated tokens for multi-bot) and `DATABASE_URL` / `REDIS_URL`.
2. Enable the required Gateway Intents in the Discord Developer Portal (see [docs/DISCORD_INTENTS.md](docs/DISCORD_INTENTS.md)).
3. Launch with Docker Compose:

```bash
docker compose up -d
```

Or run locally with Node.js >= 22 and `pnpm`:

```bash
pnpm install
pnpm build
pnpm db:migrate
pnpm start
```

## Verification & Benchmarks

```bash
pnpm lint          # Biome lint across packages, apps, tests
pnpm typecheck     # Strict TypeScript check across workspace
pnpm test          # Unit, integration, and real FFmpeg/Opus audio e2e tests
pnpm bench:audio   # Multi-session (1, 5, 10, 25) audio benchmark -> docs/AUDIO_BENCHMARKS.md
```

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System boundaries and data flow
- [docs/FEATURE_INVENTORY.md](docs/FEATURE_INVENTORY.md) — Complete V1 feature audit
- [docs/COMMAND_PARITY.md](docs/COMMAND_PARITY.md) — Full 31-command & alias matrix
- [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md) — Upgrading from V1 SQLite/JSON
- [docs/DISCORD_INTENTS.md](docs/DISCORD_INTENTS.md) — Privileged intents & permission checklist
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Docker Compose, standalone, and multi-bot setup
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — Monitoring, troubleshooting, and runbooks
- [docs/AUDIO_BENCHMARKS.md](docs/AUDIO_BENCHMARKS.md) — Repeatable benchmark output

## License & Attribution

Licensed under **CC-BY-NC-ND-4.0** (see [LICENSE](LICENSE) and [NOTICE](NOTICE)). Original Rawon project by Stegripe Development (`https://github.com/stegripe/rawon`).
