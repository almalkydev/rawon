# Rawon V2 — Complete Feature Inventory (Audited from `rawon-4.7.0`)

**Source Audited:** `E:\DevFiles\rawon-4.7.0` (`stegripe/rawon` v4.7.0, license `CC-BY-NC-ND-4.0`)  
**Audit Scope:** Every source file under `src/`, `lang/` (14 locales), `index.js`, `package.json`, `Dockerfile`, `docker-compose.yaml`, `docs/`, `.env.example`, and `dev.env.example`.

---

## 1. Runtime, Entrypoints & Build Pipeline

| Item | Legacy Behavior (`rawon-4.7.0`) | Location |
|---|---|---|
| Bootstrapper | `index.js` checks `GITHUB_*` warning, verifies FFmpeg via `prism-media` (`ffmpeg-static` auto-install via `pnpm` if absent), ensures `yt-dlp` binary download/update, imports `./dist/index.js` | [index.js](file:///E:/DevFiles/rawon-4.7.0/index.js) |
| Entrypoint Dispatch | Single-bot (`./bot.js`), Multi-bot (`MultiBotLauncher` sequential launch per token in `DISCORD_TOKEN` CSV), or Discord.js `ShardingManager` (`ENABLE_SHARDING=yes`) | [src/index.ts](file:///E:/DevFiles/rawon-4.7.0/src/index.ts) |
| Framework & Build | `@sapphire/framework` + `@stegripe/command-context` + `discord.js` 14.26.4 + TypeScript (`tsc`) | [package.json](file:///E:/DevFiles/rawon-4.7.0/package.json) |
| Graceful Shutdown | Stops `yt-dlp` auto-updater, persists queue states with a 5s timeout, closes Chromium login browser, destroys Discord client | [src/bot.ts](file:///E:/DevFiles/rawon-4.7.0/src/bot.ts) |
| Environment Config | Loads `dev.env` then `.env`; preserves worker `DISCORD_TOKEN` in multi-bot mode; `NODE_ENV=development` overrides prefix to `d!` | [src/config/env.ts](file:///E:/DevFiles/rawon-4.7.0/src/config/env.ts) |

### Environment Variables Inventory
- `DISCORD_TOKEN` (single token or comma-separated tokens for multi-bot mode)
- `STEGRIPE_API_LYRICS_TOKEN` (Bearer token for `https://api.stegripe.org/api/v1/lyrics`)
- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` (Client Credentials flow for metadata resolution)
- `MAIN_PREFIX` (default `!`, overridden to `d!` in development mode)
- `MAIN_SERVER` (optional primary/support guild ID)
- `DEVS` (comma-separated Discord user IDs for developer-only commands)
- `LOCALE` (default `en-US`; 14 supported locales)
- `ACTIVITY_TYPES`, `ACTIVITIES` (comma-separated presence templates with placeholders)
- `ENABLE_PREFIX` (`yes`/`no`, gates `GatewayIntentBits.MessageContent`)
- `ENABLE_SLASH_COMMAND` (`yes`/`no`)
- `ENABLE_SHARDING` (`yes`/`no`)
- `DEVTOOLS_PORT` (TCP proxy port for remote Chromium DevTools during Google login)
- `CHROMIUM_PATH` (optional custom Chromium executable path)
- `NODE_ENV`, `DEBUG_MODE`

---

## 2. Music Providers & Extraction Mechanisms

| Provider | Resolution Mechanism | Stream Playback | Metadata & Artwork |
|---|---|---|---|
| **YouTube** | URL regex / `yt-dlp` `--dump-single-json`, `--flat-playlist` / `--no-playlist`; `ytsearchN:` search (`searchProvider = "direct"`) | `yt-dlp` `bestaudio/best` stream piped through `prism.FFmpeg` to `StreamType.Arbitrary` | `yt-dlp` dump (`title`, `duration`, `thumbnails`, `uploader`/`channel`/`artist`, `is_live`); max/medium-res `i.ytimg.com` helper |
| **YouTube Music** | InnerTube `WEB_REMIX` (`youtubei.js`/raw InnerTube search in `youtubeMusicSearch.ts`) for `searchProvider = "dsp"`; preserves `music.youtube.com/watch?v=<id>` canonical display URL with `playableUrl` | Resolved via YouTube ID using `yt-dlp` | Square album art resolution (`youtubeMusicThumbnail.ts`, `=s720` / crop fallback) |
| **SoundCloud** | URL detection (`checkQuery.ts`) + `yt-dlp` `scsearchN:` and track/playlist extraction | `yt-dlp` audio stream (excluded from `AudioCacheManager`; `seek` blocked in legacy) | `yt-dlp` entry metadata |
| **Spotify** | Client Credentials OAuth2 token (`spotifyResolve.ts`) supporting tracks, playlists (paginated), albums, and artist top tracks (hardcoded `market=US`) | **Metadata-only**: resolves artist/title/ISRC-like metadata to playable YouTube / YT Music tracks with concurrency 4 | Preserves Spotify artwork/title/artist metadata on `Song` while attaching resolved playable URL |
| **Direct Audio Files / Attachments** | URL detection + Discord message `audio/*` attachments; HTTP `HEAD` inspection for `Content-Type` / `Content-Disposition` / file extension; `resolveUnknownUrl` fallback | Direct HTTPS stream via `got` (`ExpiredDirectMediaError` on 401/403/404/410 triggers metadata/attachment fallback) -> FFmpeg | Filename / ID3/URL fallback title |
| **Lyrics** | Primary: Stegripe API (`GET https://api.stegripe.org/api/v1/lyrics?q=...`, Bearer `STEGRIPE_API_LYRICS_TOKEN`); Fallback: LrcLib (`https://lrclib.net/api/search` & `/api/get`) | Text paginated into 2,048-char chunks via `ButtonPagination` | Song title, artist, album art, synced timestamp formatting |

---

## 3. Audio Playback, Queue & Effects

- **Voice Transport:** `@discordjs/voice` (`AudioPlayer`, `VoiceConnection`, custom multi-bot adapter in `createVoiceAdapter.ts` filtering `onVoiceStateUpdate` by `clientUserId`, optional `@snazzah/davey` E2EE support).
- **DSP / Filter Presets (19 filters in `ffmpegArgs.ts`):**  
  `bassboost`, `nightcore`, `vaporwave`, `treble`, `8d`, `reverse`, `surround`, `haas`, `phaser`, `gate`, `mcompand`, `flanger`, `tremolo`, `karaoke`, `vibrato`, `echo`, `spedup`, `slowed`, `reverb`.
- **Queue Features (`ServerQueue.ts`, `SongManager.ts`):**
  - Loop modes: `OFF`, `QUEUE`, `SONG`.
  - Shuffle mode (plays next song randomly or orders dynamically while tracking current track).
  - Autoplay (`autoplaySong.ts`): fetches YouTube Mix playlist `RD<videoId>`, falls back to related search; maintains recent history window (7–14 deduplicated repeat avoidance, history cap 30) and prefetches upcoming autoplay track.
  - Volume: `1`–`200` (`inlineVolume` transformer via FFmpeg); `> 100` restricted to DJ role or `ManageGuild`.
  - Seek (`seekSeconds`): tracks `seekOffset` + `res.playbackDuration`; saves position every 5s (`_positionSaveInterval`).
  - Skip lock & voting: `skipCooldownMs = 2000`, `skipVoters` quorum calculated by `ClientUtils.requiredVoters`.
  - Voice Channel Status: sets `🎵 <title>` on connected voice channel using gateway opcode 43 (`CHANNEL_INFO`) / REST `PUT /channels/:id/voice-status` (`SetVoiceChannelStatus` permission `281474976710656n`).
  - Empty VC / Deafened Requester Handling (`VoiceStateUpdateListener.ts`): 60s pause countdown before removing requester tracks (if requester leaves VC or deafens) or destroying empty VC queue (unless `always_on` enabled).
  - Stage Channel Support: auto-requests/promotes to Speaker (`suppress: false`), handles channel moves & RTC region changes (`ChannelUpdateListener.ts`).
  - Restart Recovery (`ReadyListener.ts`): restores `player_states`, `queue_states` (with `position_ms`), request channels, and orphaned guild/VC status cleanup.

---

## 4. Hydra-Style Request Channel System

- **Supported Channels:** `GuildText`, `GuildVoice`, `GuildStageVoice` (per-bot per-guild assignment via `/requestchannel set <channel>`, validated for `ViewChannel`, `SendMessages`, `EmbedLinks`, `ReadMessageHistory`, `ManageMessages`).
- **UI Layout (`RequestChannelManager.ts`):** Discord Components V2 (`ContainerBuilder`, `SectionBuilder`, `TextDisplayBuilder`, `ThumbnailBuilder`, `MediaGalleryBuilder`, `SeparatorBuilder`, two button `ActionRowBuilder`s + status display; falls back cleanly and uses `MessageFlags.SuppressNotifications | MessageFlags.IsComponentsV2`).
- **Interactive Buttons:**
  - Active in Container: `RC_LOOP`, `RC_SHUFFLE`, `RC_AUTOPLAY`, `RC_PAUSE_RESUME`, `RC_SKIP`, `RC_STOP`, `RC_VOL_DOWN`, `RC_VOL_UP`, `RC_REMOVE`.
  - Legacy handlers also wired in `InteractionCreateListener.ts`: `RC_QUEUE_LIST`, `RC_LYRICS`.
- **Automatic Message Playback (`MessageCreateListener.ts`):**
  - Any non-bot message in the request channel without command prefix is treated as a song/URL/audio-attachment query (except search selection replies `1`–`10`, `c`, `cancel`).
  - Checks VC membership, VC permissions, deafen status, and multi-bot VC ownership.
  - Deletes user request messages and auto-cleans bot feedback replies after 60 seconds (`ephemeralRequestChannel`).
  - `MessageDeleteListener.ts` cleans up DB request channel mapping if the persistent player message is deleted.
  - 500ms debounced updates with generation token to avoid Discord API rate limits and stale edits; permission fallback warnings throttled with a 60s cooldown.

---

## 5. Multi-Bot Architecture & Voice Ownership

- Single Node.js process (`MultiBotLauncher.ts`) instantiates `N` `Rawon` (`SapphireClient`) instances sequentially from CSV `DISCORD_TOKEN` list (`tokenIndex 0` = primary).
- `MultiBotManager.ts` resolves guild ownership:
  - Non-music / primary bot actions route to primary bot (or lowest `tokenIndex` present in the guild).
  - Music commands (`PLAYBACK_MUSIC_COMMANDS`) resolve to the bot holding an active queue for the user's VC -> already in that VC -> free primary bot -> free lowest-index bot (`musicCommandTarget.ts`, prefix `-1` / `@bot` / interaction routing, encoded in button/select customIds).
  - Request channels are scoped `(guild_id, bot_id)` so multiple bots can serve independent channels/VCs in the same guild.

---

## 6. Event Listeners (12 Total)

1. `ReadyListener.ts` — orphan cleanup, RC restore, queue & playback position resume, presence loop, yt-dlp auto-updater.
2. `MessageCreateListener.ts` — 5s dedup, prefix parsing (guild/alt/main/dev/`{mention}`), mention info reply, Hydra request channel auto-play.
3. `InteractionCreateListener.ts` — 10s dedup, wrong-bot notification, `RC_*` button handlers, `<userId>_delete-msg` dismissal, slash commands, context menus, string select menus.
4. `VoiceStateUpdateListener.ts` — bot disconnect cleanup, requester left/deaf 60s pause/removal timers, bot moved / Stage unsuppress / region change reconfigure, empty VC 60s auto-pause/destroy.
5. `ChannelDeleteListener.ts` — cleans up deleted request channels or voice channels with active queues.
6. `ChannelUpdateListener.ts` — reconfigures voice networking when VC region (`rtcRegion`) changes.
7. `GuildDeleteListener.ts` — destroys queue and purges guild DB records on guild removal.
8. `MessageDeleteListener.ts` — clears RC mapping if player message is deleted.
9. `DebugListener.ts` — client debug logs.
10. `WarnListener.ts` — client warning logs.
11. `ErrorListener.ts` — client error logs.
12. `ListenerErrorListener.ts` — suppresses known Sapphire `CoreReady` multi-bot noise and logs listener exceptions.

---

## 7. Persistence Schema (`SQLiteDataManager.ts`) & Caching

### SQLite Tables (`cache/data.db`, WAL mode, foreign keys ON)
- `guilds` (`id`, `prefix`, `locale`, `dj_enabled`, `dj_role`)
- `request_channels` (`guild_id`, `bot_id`, `channel_id`, `message_id`, composite PK `(guild_id, bot_id)`)
- `player_states` (`guild_id`, `bot_id`, `loop_mode`, `shuffle`, `autoplay`, `volume`, `filters_json`, composite PK)
- `queue_states` (`guild_id`, `bot_id`, `voice_channel_id`, `text_channel_id`, `current_song_key`, `position_ms`, `paused`, `songs_json`, composite PK)
- `voice_channel_status_states` (`guild_id`, `bot_id`, `channel_id`, `status_set`, composite PK)
- `cookies_state` (`id=1`, `last_refresh`, `cookie_hash`)
- `bot_settings` (`key`, `value`) — defaults (`BOT_SETTINGS_DEFAULTS`): `embed_color`, `yes_emoji`, `no_emoji`, `alt_prefix`, `request_channel_splash`, `default_volume=100`, `music_selection_type="message"`, `search_provider="dsp"`, `always_on=0`, `enable_audio_cache=1`
- `login_session` (managed in `GoogleLoginManager.ts`): session status, logged-in email, `visitor_data`

### Caching, Prefetching & Auth
- **Audio Disk Cache (`AudioCacheManager.ts`):** Stores `cache/audio/<md5(url)>.opus` (max 500MB, 50 files, LRU eviction to 50%), background precache worker (max 2 concurrent, 5 songs ahead, plus `preCacheNextSong` 3 ahead in `ServerQueue`), skips SoundCloud, tees HTTP/yt-dlp streams via `PassThrough`.
- **Google Login & Cookies (`CookiesManager.ts`, `GoogleLoginManager.ts`):** Singleton shared across bots; spawns `puppeteer-core` Chromium with stealth plugin and `0.0.0.0:${DEVTOOLS_PORT}` TCP proxy for remote login; exports Netscape `cache/cookies/cookies.txt` + `.backup` and passes `--extractor-args youtube:visitor_data=...` to `yt-dlp`.

---

## 8. Licensing & Attribution Requirements

- **License:** `CC-BY-NC-ND-4.0` (Stegripe Development, `support@stegripe.org`, `https://github.com/stegripe/rawon`).
- **Disclaimers & Notices:** Preserve attribution, non-commercial terms notice, FFmpeg / yt-dlp / third-party attribution, and legitimate `STEGRIPE_API_LYRICS_TOKEN` Bearer integration. Do not circumvent Spotify DRM, Discord `MessageContent` privileged intent rules, or YouTube/provider protections.

---

## 9. Audited Bugs, Architectural Limitations & Bottlenecks

1. **Always-Transcode Audio Pipeline (No Opus Passthrough):** `yt-dlp` feeds raw WebM/M4A/Opus into `prism.FFmpeg` with `-vn -ar 48000 -ac 2 -f opus -acodec libopus` (`StreamType.Arbitrary`) even when source is already 48 kHz stereo Opus and no filters are active — wasting significant CPU per voice session.
2. **Broken/Expensive Seeking on Uncached Streams:** `play.ts` buffers the entire track to `os.tmpdir()/rawon-direct-*.tmp` before FFmpeg runs, and `ffmpegArgs.ts` places `-i <path>` *before* `-ss <sec>` (slow full decode-to-offset instead of fast input seek).
3. **JSON Blob Churn in SQLite:** Every `SongManager.set()`/`delete()` and 5s position timer serializes the full `songs_json` blob into SQLite via synchronous `better-sqlite3`.
4. **Audio Cache Corruption & Key Collisions:** Files use `.opus` regardless of actual container, cache key is `md5(url)` (fails when signed CDN URLs change or `playableUrl !== url`), full disk cache is wiped on boot, active song cache is deleted on `queue.destroy()`, and `waitForCache()` polls every 200ms up to 300s.
5. **Unbounded In-Memory Caches:** Global `thumbnailCache` Map in `youtubeMusicThumbnail.ts` never evicts entries; search results and metadata are repeatedly re-fetched without TTL caches.
6. **Multi-Bot Single-Process & Event Forwarding Hacks:** All bots run in one Node.js process sharing one SQLite file; `Rawon.ts` manually forwards 7 events because Sapphire's `container.client` assumes a single bot. No distributed Redis election, lease lock, or cross-process failover.
7. **Broken Message Context Menu Check:** `InteractionCreateListener.ts:268` checks `interaction.isUserContextMenuCommand()` before reading `.options.get("message")`, breaking Message Context Menu interactions.
8. **`SetupCommand` Reset Bug:** `setup reset` omits `always_on`, leaving `always_on=1` stale after reset.
9. **No Request-Channel Anti-Spam, Queue Cap, or SSRF Guard:** Arbitrary direct HTTP URLs (including private IPs/`file:` edge risks) are fetched via `got.head()`/`yt-dlp` and `/db-import` without SSRF validation; request channel lacks per-user sliding-window rate limits and queue length caps.
10. **Fragile Legacy Command Compatibility:** Mixes Sapphire store, `CommandsCompatibility`, unused `CommandManager`, and ad-hoc `client.commands.get(...)` calls.
