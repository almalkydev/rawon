# Rawon V2 — Migration & Upgrade Plan (`v4.7.0` -> `V2`)

## 1. Non-Destructive Side-by-Side Strategy

1. The existing `E:\DevFiles\rawon-4.7.0` codebase remains **intact** as the verified reference baseline throughout implementation and testing.
2. All Rawon V2 modules, apps, Docker configuration, and tests are built cleanly in `E:\DevFiles\rawon-v2` without relying on legacy Sapphire/JSON hacks.
3. Database migration provides first-class compatibility so existing deployments with `cache/data.db` (SQLite) or `rawon-db-export-*.json` files upgrade seamlessly into PostgreSQL without data loss.

---

## 2. Database & State Migration Mapping

| Legacy SQLite (`cache/data.db`) | Rawon V2 PostgreSQL Table | Migration Transformation |
|---|---|---|
| `guilds (id, prefix, locale, dj_enabled, dj_role)` | `guilds` | `guild_id = id`, default `max_queue_size = 500`, `rc_rate_limit = 5/15s` |
| `request_channels (guild_id, bot_id, channel_id, message_id)` | `request_channels` | Preserved `(guild_id, bot_id)` composite key; `bot_settings.request_channel_splash` inherited or per-row overridable |
| `player_states (..., loop_mode, shuffle, autoplay, volume, filters_json)` | `player_states` | Preserved + adds `quality_profile = 'fidelity'`, `normalize_audio = false` |
| `queue_states (..., songs_json, position_ms, current_song_key)` | `queue_sessions` + `queue_tracks` | Normalized `songs_json` array into ordered rows in `queue_tracks` preserving `key`, metadata, `requesterId`, and exact resume `position_ms` |
| `voice_channel_status_states` | `voice_channel_status_states` | Direct 1:1 migration so orphaned VC statuses are cleared cleanly on V2 first boot |
| `cookies_state` + `login_session` | `auth_sessions` | Migrates metadata (`email`, `visitor_data`, `cookie_hash`, `last_refresh`) + reuses `cache/cookies/cookies.txt` |
| `bot_settings (key, value)` | `bot_settings` | Maps snake_case keys cleanly; fixes legacy `reset` omission of `always_on` |

### Automated Importers & CLI
- `pnpm --filter @rawon/database migrate`: Applies idempotent SQL migrations to PostgreSQL (`DATABASE_URL`).
- `pnpm --filter @rawon/database import-legacy <path-to-data.db-or-export.json>`: Migrates V1 SQLite (`better-sqlite3` reader) or `/db-export` JSON files directly into PostgreSQL.
- `/db-import` & `/db-export` Discord commands continue supporting the V1 JSON export schema (`version: "1.0.0"`) AND V2 normalized exports (`version: "2.0.0"`).

---

## 3. Staged Engineering Execution Phases

| Phase | Deliverables | Verification Gate |
|---|---|---|
| **Phase 1 & 2** | Complete audit + `docs/{FEATURE_INVENTORY,ARCHITECTURE,COMMAND_PARITY,MIGRATION_PLAN}.md` | Peer-review against 100% of `rawon-4.7.0` files |
| **Phase 3** | Workspace setup + `shared`, `config`, `queue`, `providers`, `music-core` | `tsc --noEmit`, Biome lint, provider & queue unit tests |
| **Phase 4** | `audio-engine` (Opus passthrough, fast `-ss` FFmpeg, 19+ filters, EQ, ReplayGain, `ProcessSupervisor`) + `cache` (L1/L2/L3 atomic) | Audio integration tests + real multi-concurrency benchmarks (`1, 5, 10, 25` sessions) |
| **Phase 5 & 6** | `discord` package + `apps/bot` (31 commands, context menus, autocomplete, Components V2 persistent player, Hydra RequestChannel, 14 locales) | Interaction & RequestChannel integration tests |
| **Phase 7** | `database` (PostgreSQL + legacy SQLite/JSON bridge) + Redis distributed coordination + `apps/worker` multi-bot failover & restart recovery | Integration tests w/ real/emulated coordination & DB migration tests |
| **Phase 8** | Security hardening (SSRF, bounded queues, rate limits, auth guards), full test suite + load benchmarks | All unit, integration, audio & performance suites pass cleanly |
| **Phase 9 & 10** | Multi-stage `Dockerfile`, `docker-compose.yml`, `.env.example`, full `docs/` & `README.md`, license/attribution files | Final build, parity verification, benchmark & audit report |
