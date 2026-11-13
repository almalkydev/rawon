# Rawon V2 — Complete Command & UI Parity Matrix

Every command, alias, subcommand, argument, permission decorator, and UI control from `rawon-4.7.0` is preserved with 100% behavioral parity in Rawon V2, plus new V2 enhancements (`previous` command, Components V2 persistent controls, autocomplete, and localization).

---

## 1. Command Parity Table (All 30 Legacy Commands + V2 `previous`)

### Developer Commands (Precondition: `DevOnly` / `DEVS` env list)

| Command | Aliases | Subcommands & Options | Permissions / Guards | V2 Parity & Improvements |
|---|---|---|---|---|
| `db-export` | `database-export`, `export-db`, `dbexport` | None | `DevOnly`, bot `ViewChannel`, `SendMessages`, `EmbedLinks`, `AttachFiles` | Exports PostgreSQL tables + rawon SQLite-compatible JSON schema `version: "1.0.0"` to safe artifact path & Discord attachment (`ensureDir` fix) |
| `db-import` | `database-import`, `import-db`, `dbimport` | `file` (Attachment), `url` (String URL or filename in `data/`) | `DevOnly` | Imports both V1 SQLite export JSON (`tables`) and V2 JSON inside a PostgreSQL transaction; SSRF-safe HTTP fetch (allows Discord CDN / public HTTPS only); path-traversal safe filename resolution inside `data/` |
| `eval` | `evaluate`, `ev`, `js-exec` | Prefix args (`--async`, `--silent`) + slash/modal support | `DevOnly` | Isolated async evaluation with comprehensive secret redaction (all `DISCORD_TOKEN`s, DB URL, Redis password, Spotify secrets); Stegripe/safe paste fallback |
| `login` | `google-login`, `gl` | `start`, `status`, `logout` | `DevOnly` | Preserves cookie workflow & DevTools remote Chromium login session management + Redis/Postgres session sync; authenticated/ephemeral token/URL handling |
| `setup` | `config`, `settings` | No arg (overview), `view`, `embedcolor <hex\|reset>`, `yesemoji <emoji\|reset>`, `noemoji <emoji\|reset>`, `altprefix <csv\|reset>`, `splash <url\|reset>`, `defaultvolume <1-200\|0>`, `selectiontype <message\|selectmenu\|reset>`, `search <dsp\|direct\|reset>`, `alwayson <bool>`, `audiocache <bool>`, `reset` | `DevOnly` | Fixes legacy `setup reset` bug (includes `always_on` reset option cleanly); persisted in PostgreSQL `bot_settings` + propagated over Redis pub/sub to all workers/instances |

### General Commands

| Command | Aliases | Subcommands & Options | Permissions / Guards | V2 Parity & Improvements |
|---|---|---|---|---|
| `about` | `information`, `info`, `botinfo`, `stats` | None | Guild / DM safe | Displays OS/process/bot uptime, cached users, channels, guilds, Node.js, discord.js, FFmpeg version, bot version, commit hash, active audio sessions, cache hit rate, attribution & source link |
| `help` | `h`, `command`, `commands`, `cmd`, `cmds` | `command` (String, optional — V2 adds slash **autocomplete**) | Hides `devOnly` from non-devs | Categorized overview + detailed command view + interactive StringSelectMenu fuzzy match |
| `invite` | `inv` | None | None | Multi-bot aware invite generator including `SetVoiceChannelStatus` (`281474976710656n`), `BypassSlowmode`, `SendVoiceMessages`, `Connect`, `Speak`, etc. |
| `language` | `lang`, `locale` | `set <locale>`, `view`, `reset` (14 locales) | `ManageGuild` | Persisted per-guild in PostgreSQL + cached in Redis; slash choices for all 14 locales |
| `ping` | `pang`, `pung`, `peng`, `pong` | None | None | Reports REST API latency, Gateway WS ping, Voice WS/UDP ping, and active worker node latency |
| `prefix` | `setprefix` | `set <prefix>`, `view`, `reset` | `ManageGuild`, max 10 chars | Persisted per-guild in PostgreSQL `guilds.prefix` + Redis cache |

### Music Commands

| Command | Aliases | Subcommands & Options | Permissions / Guards | V2 Parity & Improvements |
|---|---|---|---|---|
| `autoplay` | `ap` | `state`: `enable` \| `disable` \| omit for status | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Toggles/reads queue & persistent `player_states.autoplay` |
| `dj` | — | `enable`, `disable`, `role [newrole]` (prefix alias `set`) | `ManageGuild` | Enables/disables DJ mode and configures DJ role in PostgreSQL + Redis |
| `filter` | — | `enable\|on <filter>`, `disable\|off <filter>`, `status\|stats [filter]` (19 presets + V2 EQ) | `@inVC`, `@validVC`, `@sameVC` | Persists filters even when no queue is active; seamlessly hot-swaps audio pipeline at current playback timestamp without full re-download |
| `lyrics` | `ly`, `lyric` | `query` (String, optional — defaults to current playing song) | Works anywhere in guild | Stegripe API (`STEGRIPE_API_LYRICS_TOKEN`) primary -> LrcLib fallback -> Redis TTL cache -> paginated 2048-char UI |
| `nowplaying` | `np` | None | `@haveQueue` | Rich progress bar + metadata; outside RC renders interactive buttons (updates smoothly without spamming edits) |
| `pause` | — | None | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Pauses `AudioPlayer` and saves exact position in Redis/PostgreSQL |
| `play` | `p`, `add` | `query` (String w/ autocomplete from search/history) or message `audio/*` attachment | `@useRequestChannel`, `@inVC`, `@validVC`, `@sameVC`, not deafened | Supports YouTube, YT Music, SoundCloud, Spotify URLs, direct audio URLs, Discord audio attachments, playlists, artists; checks VC exclusivity & multi-bot assignment |
| `previous` *(V2 addition)* | `prev`, `back` | None | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC`, DJ/Requester/Vote | Plays previous track from bounded queue/history cleanly (matches V2 player Previous button) |
| `queue` | `q` | None | `@haveQueue` | Paginated queue (`10` tracks/page) with loop-aware ordering & total remaining duration |
| `remove` | — | `positions` (comma/space separated indices) | `@inVC`, `@haveQueue`, `@sameVC`, `hasRemoveSelectionPermission` | Validates permissions per track, cleanly skips if removing active song |
| `repeat` | `loop`, `music-repeat`, `music-loop` | `queue`/`all`, `song`/`one`/`current`/`this`/`1`, `disable`/`off`/`0` | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Sets `OFF`, `QUEUE`, `SONG` + persists to `player_states` |
| `requestchannel` | `rc`, `reqchannel`, `musicchannel` | `set <channel>`, `remove`, `status` (Text/Voice/Stage channels) | `ManageGuild`; verifies bot channel perms | Sets up Components V2 persistent player message, enforces single-bot ownership of target channel, supports multi-bot per-guild channels + configurable RC exclusions/rate limits |
| `resume` | — | None | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Blocks resuming while `requesterDeafTimeout` is active; restores exact stream |
| `search` | `sc` | `query` (String), `source` (`youtube` \| `soundcloud`) | `@inVC`, `@validVC`, `@sameVC`, RC-only rule when RC exists | Supports both numbered message selection (`1, 2, 3`, `c`/`cancel`) and StringSelectMenu modes; V2 fixes auto-delete timers & cleans up expired collectors |
| `seek` | `sk` | `time` (`1:30`, `90`, `1h2m3s`) | `@inVC`, `@haveQueue`, `@sameVC`, `hasMusicControlPermission` | Fast FFmpeg input seeking (`-ss` before `-i`) works immediately on cached tracks AND directly on range-seekable HTTP/stream URLs without full temp-file buffering; rejects live streams |
| `shuffle` | — | `state`: `enable` \| `disable` \| omit | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Shuffles remaining queue tracks deterministically cleanly without corrupting current track |
| `skip` | `s` | None | `@useRequestChannel`, `@inVC`, `@haveQueue`, `@sameVC` | Immediate skip for requester / DJ / `ManageGuild`; otherwise vote-skip quorum (`floor(listeners/2)+1` etc. per `requiredVoters`) |
| `skipto` | `st` | `first`, `last`, `specific <position>` | `@inVC`, `@haveQueue`, `@sameVC`, `hasMusicControlPermission` | Jumps to queue position or first/last track cleanly |
| `stop` | `disconnect`, `dc` | None | `@useRequestChannel`, `@inVC`, `@validVC`, `@haveQueue`, `@sameVC`, `hasMusicControlPermission` | Cancels active FFmpeg/stream processes, clears VC status, resets player message to standby, destroys voice connection & releases distributed lock |
| `volume` | `vol` | `volume` (Number `1`–`200`, optional — interactive buttons when omitted) | `@inVC`, `@validVC`, `@haveQueue`, `@sameVC`; `>100` requires DJ/`ManageGuild` | Smooth gain transition; interactive preset buttons + Volume modal support on persistent player |

---

## 2. Modern Discord API & Persistent Player Control Parity

### Request Channel Persistent Player (Components V2)
Implemented strictly with valid Discord Components V2 hierarchy (`MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications`, never illegally mixing top-level `embeds` with Components V2 containers):
- **Display Header & Artwork:** `ContainerBuilder` + `SectionBuilder` (Title, Artist, Source badge, Progress bar & timestamps, Volume %, Loop/Shuffle/Autoplay badges, Active Filters, Queue count & total duration, Requester mention) + `ThumbnailBuilder` (`safeThumbUrl`) + optional idle banner `MediaGalleryBuilder` (splash image).
- **Row 1 (Transport):** `RC_PREV` (Previous), `RC_PAUSE_RESUME` (Pause/Resume), `RC_SKIP` (Skip), `RC_STOP` (Stop), `RC_REMOVE` (Remove track modal/menu).
- **Row 2 (Modes & Utilities):** `RC_LOOP` (Off -> Queue -> Song), `RC_SHUFFLE`, `RC_AUTOPLAY`, `RC_QUEUE_LIST` (Ephemeral paginated Queue), `RC_LYRICS` (Ephemeral Lyrics).
- **Row 3 (Audio Controls):** `RC_VOL_DOWN` (`-10%`), `RC_VOL_UP` (`+10%`), `RC_VOL_MODAL` (Custom Volume modal `1–200`), `RC_FILTER_SELECT` / `RC_FILTER_BTN` (Ephemeral DSP Filter selector).

### Context Menu & Autocomplete Interactions
- **Message Context Menu (`Play Track` / `Search Track`):** Extracts URL or song title from right-clicked message and queues/searches (fixes legacy `isUserContextMenuCommand()` vs `isMessageContextMenuCommand()` bug).
- **Slash Autocomplete:** Live autocomplete for `/play query`, `/help command`, and `/filter` options.
- **Slash Localization:** Localized command descriptions and names derived from the 14 existing locale JSON bundles (`en-US`, `es-ES`, `fr-FR`, `id-ID`, `ja-JP`, `ko-KR`, `ms-MY`, `pt-BR`, `ru-RU`, `tr-TR`, `uk-UA`, `vi-VN`, `zh-CN`, `zh-TW`).

---

## 3. Decorator & Permission Guard Parity

- `@inVC`: Caller must be in a guild voice/stage channel.
- `@validVC`: Bot must have `Connect` and `Speak` (or Stage request/speak) permissions, or already connected.
- `@haveQueue`: Active queue must exist for the target bot in the guild.
- `@sameVC`: Caller must share the bot's voice channel if connected.
- `@useRequestChannel`: Rejects command outside configured request channel (unless command is allowed globally or targeting another bot in multi-bot mode); inside request channel rejects `/play`, `/pause`, etc. if configured direct-only rule applies (`useRequestChannelDirect`), with ephemeral/auto-cleaned guidance.
- `hasMusicControlPermission`: Allows requester, DJ role (when `dj.enabled`), or `ManageGuild` (plus `Administrator`).
- `hasRemoveSelectionPermission`: Allows DJ role / `ManageGuild`, or member who requested every selected track.
