import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createDefaultPlayerState } from "@rawon/config";
import {
    type AuthLoginStatus,
    assertSafePublicUrl,
    type LoopMode,
    type QueuedTrack,
    type RequestChannelExclusions,
    type SourceProviderType,
    type Track,
    ValidationError,
} from "@rawon/shared";
import type { DatabaseStore } from "./interfaces.js";
import { PostgresDatabaseStore } from "./PostgresStore.js";

export type SnapshotData = Awaited<ReturnType<DatabaseStore["exportSnapshot"]>>;

export interface DatabaseExportBundle {
    version: "1.0.0" | "2.0.0";
    exportedAt: string;
    schemaVersion?: number;
    data: SnapshotData;
}

export interface MigrationImportCounts {
    guilds: number;
    request_channels: number;
    player_states: number;
    queue_states: number;
    voice_channel_status_states: number;
    cookies_state: number;
    bot_settings: number;
}

const VALID_SOURCES = new Set<SourceProviderType>([
    "youtube",
    "youtubemusic",
    "soundcloud",
    "spotify",
    "direct",
    "attachment",
    "unknown",
]);

function normalizeLoopMode(value: unknown): LoopMode {
    if (typeof value === "string") {
        const upper = value.toUpperCase();
        if (upper === "QUEUE" || upper === "ALL" || upper === "2") return "QUEUE";
        if (upper === "SONG" || upper === "TRACK" || upper === "1") return "SONG";
    }
    if (value === 1) return "SONG";
    if (value === 2) return "QUEUE";
    return "OFF";
}

function normalizeSource(value: unknown, url?: string): SourceProviderType {
    if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (lower === "ytmusic" || lower === "youtube_music" || lower === "youtubemusic") {
            return "youtubemusic";
        }
        if (lower === "yt" || lower === "youtube") return "youtube";
        if (lower === "sc" || lower === "soundcloud") return "soundcloud";
        if (lower === "sp" || lower === "spotify") return "spotify";
        if (VALID_SOURCES.has(lower as SourceProviderType)) {
            return lower as SourceProviderType;
        }
    }
    if (url) {
        if (url.includes("music.youtube.com")) return "youtubemusic";
        if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
        if (url.includes("soundcloud.com")) return "soundcloud";
        if (url.includes("spotify.com")) return "spotify";
        return "direct";
    }
    return "unknown";
}

function normalizeAuthStatus(value: unknown): AuthLoginStatus {
    if (
        value === "idle" ||
        value === "waiting_for_login" ||
        value === "logged_in" ||
        value === "error"
    ) {
        return value;
    }
    return "idle";
}

function parseJsonSafe<T>(raw: unknown, fallback: T): T {
    if (raw === null || raw === undefined) return fallback;
    if (typeof raw === "object") return raw as T;
    if (typeof raw !== "string") return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function normalizeLegacyTrack(
    raw: Record<string, unknown>,
    fallbackIndex: number,
): QueuedTrack | null {
    const nestedTrack =
        raw.track && typeof raw.track === "object" ? (raw.track as Record<string, unknown>) : null;
    const srcObj = nestedTrack ?? raw;

    const url =
        typeof srcObj.url === "string"
            ? srcObj.url
            : typeof srcObj.uri === "string"
              ? srcObj.uri
              : "";
    const title = typeof srcObj.title === "string" ? srcObj.title : "";
    if (!url && !title) {
        return null;
    }

    const provider = normalizeSource(srcObj.provider ?? srcObj.source ?? srcObj.sourceName, url);
    const id =
        typeof srcObj.id === "string"
            ? srcObj.id
            : typeof srcObj.identifier === "string"
              ? srcObj.identifier
              : url || `track_${fallbackIndex}`;
    const author =
        typeof srcObj.author === "string"
            ? srcObj.author
            : typeof srcObj.artist === "string"
              ? srcObj.artist
              : undefined;
    const durationRaw = srcObj.duration ?? srcObj.durationSec ?? 0;
    const duration =
        typeof durationRaw === "number" && Number.isFinite(durationRaw) && durationRaw >= 0
            ? Math.floor(durationRaw)
            : 0;
    const thumbnail =
        typeof srcObj.thumbnail === "string"
            ? srcObj.thumbnail
            : typeof srcObj.thumbnailUrl === "string"
              ? srcObj.thumbnailUrl
              : "";

    const requesterId =
        typeof raw.requesterId === "string"
            ? raw.requesterId
            : typeof raw.requester === "string"
              ? raw.requester
              : "0";

    const key =
        typeof raw.key === "string" && raw.key.length > 0 ? raw.key : `${id}_${fallbackIndex}`;

    const index =
        typeof raw.index === "number" && Number.isFinite(raw.index) ? raw.index : fallbackIndex + 1;

    const track: Track = {
        id,
        title: title || "Unknown Title",
        url,
        playableUrl: typeof srcObj.playableUrl === "string" ? srcObj.playableUrl : undefined,
        duration,
        thumbnail,
        author,
        isLive: Boolean(srcObj.isLive ?? srcObj.isStream ?? false),
        provider,
        spotifyId: typeof srcObj.spotifyId === "string" ? srcObj.spotifyId : undefined,
        spotifyUrl: typeof srcObj.spotifyUrl === "string" ? srcObj.spotifyUrl : undefined,
        isrc: typeof srcObj.isrc === "string" ? srcObj.isrc : undefined,
        album: typeof srcObj.album === "string" ? srcObj.album : undefined,
        resolvedBy:
            typeof srcObj.resolvedBy === "string" ? normalizeSource(srcObj.resolvedBy) : undefined,
    };

    return {
        key,
        index,
        track,
        requesterId,
        requesterTag: typeof raw.requesterTag === "string" ? raw.requesterTag : undefined,
        addedAt: typeof raw.addedAt === "number" ? raw.addedAt : Date.now(),
    };
}

export function parseAndValidateBundle(raw: unknown): DatabaseExportBundle {
    if (!raw || typeof raw !== "object") {
        throw new ValidationError("Database export payload must be a JSON object");
    }
    const obj = raw as Record<string, unknown>;
    const version = obj.version;
    if (version !== "1.0.0" && version !== "2.0.0") {
        throw new ValidationError(`Unsupported database export version: ${String(version)}`);
    }
    if (!obj.data || typeof obj.data !== "object") {
        throw new ValidationError("Database export missing required 'data' object");
    }

    const d = obj.data as Record<string, unknown>;
    const arr = <T>(val: unknown): T[] => (Array.isArray(val) ? (val as T[]) : []);

    const guildsRaw = arr<Record<string, unknown>>(d.guilds);
    const rcRaw = arr<Record<string, unknown>>(d.request_channels);
    const psRaw = arr<Record<string, unknown>>(d.player_states);
    const qsRaw = arr<Record<string, unknown>>(d.queue_states);
    const vcRaw = arr<Record<string, unknown>>(d.voice_channel_status_states);
    const ckRaw = arr<Record<string, unknown>>(d.cookies_state);
    const bsRaw = arr<Record<string, unknown>>(d.bot_settings);

    const defaults = createDefaultPlayerState();

    return {
        version,
        exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : new Date().toISOString(),
        schemaVersion: typeof obj.schemaVersion === "number" ? obj.schemaVersion : 2,
        data: {
            guilds: guildsRaw
                .filter((g) => typeof g.id === "string" && g.id.length > 0)
                .map((g) => ({
                    id: String(g.id),
                    prefix: typeof g.prefix === "string" ? g.prefix : null,
                    locale: typeof g.locale === "string" ? g.locale : null,
                    dj_enabled: Number(g.dj_enabled) ? 1 : 0,
                    dj_role: typeof g.dj_role === "string" ? g.dj_role : null,
                    max_queue_size: Number.isFinite(Number(g.max_queue_size))
                        ? Number(g.max_queue_size)
                        : 500,
                    rc_rate_limit_max: Number.isFinite(Number(g.rc_rate_limit_max))
                        ? Number(g.rc_rate_limit_max)
                        : 5,
                    rc_rate_limit_window_ms: Number.isFinite(Number(g.rc_rate_limit_window_ms))
                        ? Number(g.rc_rate_limit_window_ms)
                        : 15_000,
                    rc_exclusions_json:
                        typeof g.rc_exclusions_json === "string"
                            ? g.rc_exclusions_json
                            : JSON.stringify(g.rc_exclusions_json ?? {}),
                })),
            request_channels: rcRaw
                .filter((r) => typeof r.guild_id === "string" && typeof r.channel_id === "string")
                .map((r) => ({
                    guild_id: String(r.guild_id),
                    bot_id: typeof r.bot_id === "string" && r.bot_id ? r.bot_id : "default",
                    channel_id: String(r.channel_id),
                    message_id: typeof r.message_id === "string" ? r.message_id : null,
                })),
            player_states: psRaw
                .filter((p) => typeof p.guild_id === "string")
                .map((p) => ({
                    guild_id: String(p.guild_id),
                    bot_id: typeof p.bot_id === "string" && p.bot_id ? p.bot_id : "default",
                    loop_mode: normalizeLoopMode(p.loop_mode),
                    shuffle: Number(p.shuffle) ? 1 : 0,
                    autoplay: Number(p.autoplay) ? 1 : 0,
                    volume:
                        typeof p.volume === "number" && Number.isFinite(p.volume)
                            ? Math.max(0, Math.min(200, Math.round(p.volume)))
                            : defaults.volume,
                    quality_profile:
                        p.quality_profile === "balanced" || p.quality_profile === "low-bandwidth"
                            ? p.quality_profile
                            : "fidelity",
                    normalize_audio: Number(p.normalize_audio) ? 1 : 0,
                    filters_json:
                        typeof p.filters_json === "string"
                            ? p.filters_json
                            : JSON.stringify(p.filters_json ?? {}),
                    equalizer_json:
                        typeof p.equalizer_json === "string"
                            ? p.equalizer_json
                            : JSON.stringify(p.equalizer_json ?? []),
                })),
            queue_states: qsRaw
                .filter(
                    (q) => typeof q.guild_id === "string" && typeof q.voice_channel_id === "string",
                )
                .map((q) => ({
                    guild_id: String(q.guild_id),
                    bot_id: typeof q.bot_id === "string" && q.bot_id ? q.bot_id : "default",
                    voice_channel_id: String(q.voice_channel_id),
                    text_channel_id:
                        typeof q.text_channel_id === "string"
                            ? q.text_channel_id
                            : String(q.voice_channel_id),
                    current_song_key:
                        typeof q.current_song_key === "string" ? q.current_song_key : null,
                    position_ms: Math.max(0, Number(q.position_ms) || 0),
                    paused: Number(q.paused) ? 1 : 0,
                    songs_json:
                        typeof q.songs_json === "string"
                            ? q.songs_json
                            : JSON.stringify(Array.isArray(q.songs_json) ? q.songs_json : []),
                })),
            voice_channel_status_states: vcRaw
                .filter((v) => typeof v.guild_id === "string" && typeof v.channel_id === "string")
                .map((v) => ({
                    guild_id: String(v.guild_id),
                    bot_id: typeof v.bot_id === "string" && v.bot_id ? v.bot_id : "default",
                    channel_id: String(v.channel_id),
                    status_set: Number(v.status_set) ? 1 : 0,
                })),
            cookies_state: ckRaw.map((c) => ({
                id: Number.isFinite(Number(c.id)) ? Number(c.id) : 1,
                last_refresh:
                    c.last_refresh !== null && c.last_refresh !== undefined
                        ? Number(c.last_refresh)
                        : null,
                cookie_hash: typeof c.cookie_hash === "string" ? c.cookie_hash : null,
                email: typeof c.email === "string" ? c.email : null,
                visitor_data: typeof c.visitor_data === "string" ? c.visitor_data : null,
                status: typeof c.status === "string" ? c.status : null,
            })),
            bot_settings: bsRaw
                .filter((b) => typeof b.key === "string" && b.key.length > 0)
                .map((b) => ({
                    key: String(b.key),
                    value:
                        typeof b.value === "string"
                            ? b.value
                            : b.value === null
                              ? null
                              : String(b.value),
                })),
        },
    };
}

export async function exportDatabaseBundle(store: DatabaseStore): Promise<DatabaseExportBundle> {
    const data = await store.exportSnapshot();
    return {
        version: "2.0.0",
        exportedAt: new Date().toISOString(),
        schemaVersion: 2,
        data,
    };
}

export async function fetchExportBundleFromUrl(
    url: string,
    options?: { maxBytes?: number; timeoutMs?: number },
): Promise<DatabaseExportBundle> {
    await assertSafePublicUrl(url);
    const maxBytes = options?.maxBytes ?? 25 * 1024 * 1024;
    const timeoutMs = options?.timeoutMs ?? 20_000;

    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json" },
    });
    if (!response.ok) {
        throw new ValidationError(
            `Failed to download database import URL (${response.status} ${response.statusText})`,
        );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > maxBytes) {
        throw new ValidationError(
            `Import payload exceeds maximum allowed size (${maxBytes} bytes)`,
        );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
        throw new ValidationError(
            `Import payload exceeds maximum allowed size (${maxBytes} bytes)`,
        );
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(buffer.toString("utf8"));
    } catch (error) {
        throw new ValidationError(
            `Invalid JSON payload in database import: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return parseAndValidateBundle(parsed);
}

function buildExclusions(rawJson: string): RequestChannelExclusions {
    const raw = parseJsonSafe<Record<string, unknown>>(rawJson, {});
    return {
        ignoredPrefixes: Array.isArray(raw.ignoredPrefixes) ? raw.ignoredPrefixes.map(String) : [],
        ignoredUserIds: Array.isArray(raw.ignoredUserIds) ? raw.ignoredUserIds.map(String) : [],
        ignoredRoleIds: Array.isArray(raw.ignoredRoleIds) ? raw.ignoredRoleIds.map(String) : [],
        requireVoiceChannel:
            typeof raw.requireVoiceChannel === "boolean" ? raw.requireVoiceChannel : true,
        deleteRequestMessages:
            typeof raw.deleteRequestMessages === "boolean" ? raw.deleteRequestMessages : true,
        deleteFeedbackAfterMs:
            typeof raw.deleteFeedbackAfterMs === "number" &&
            Number.isFinite(raw.deleteFeedbackAfterMs)
                ? raw.deleteFeedbackAfterMs
                : 7_000,
        allowMultiLineRequests:
            typeof raw.allowMultiLineRequests === "boolean" ? raw.allowMultiLineRequests : true,
    };
}

export async function importDatabaseBundle(
    store: DatabaseStore,
    bundleOrRaw: unknown,
    options?: { clearExisting?: boolean },
): Promise<{ counts: MigrationImportCounts }> {
    const bundle = parseAndValidateBundle(bundleOrRaw);
    const clearExisting = options?.clearExisting ?? true;
    const d = bundle.data;

    const counts: MigrationImportCounts = {
        guilds: 0,
        request_channels: 0,
        player_states: 0,
        queue_states: 0,
        voice_channel_status_states: 0,
        cookies_state: 0,
        bot_settings: 0,
    };

    const parsedQueues = d.queue_states.map((qs) => {
        const rawSongs = parseJsonSafe<unknown[]>(qs.songs_json, []);
        const tracks: QueuedTrack[] = [];
        for (let i = 0; i < rawSongs.length; i++) {
            const item = rawSongs[i];
            if (item && typeof item === "object") {
                const normalized = normalizeLegacyTrack(item as Record<string, unknown>, i);
                if (normalized) tracks.push(normalized);
            }
        }
        return { qs, tracks };
    });

    if (store instanceof PostgresDatabaseStore) {
        const pool = store.getPool();
        const client = await pool.connect();
        try {
            await client.query("BEGIN");

            if (clearExisting) {
                await client.query(
                    "TRUNCATE TABLE queue_tracks, queue_sessions, request_channels, player_states, voice_channel_status_states, guilds, bot_settings, auth_sessions CASCADE",
                );
            }

            for (const g of d.guilds) {
                await client.query(
                    `INSERT INTO guilds (id, prefix, locale, dj_enabled, dj_role, max_queue_size, rc_rate_limit_max, rc_rate_limit_window_ms, rc_exclusions_json, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())
                     ON CONFLICT (id) DO UPDATE SET
                        prefix = EXCLUDED.prefix,
                        locale = EXCLUDED.locale,
                        dj_enabled = EXCLUDED.dj_enabled,
                        dj_role = EXCLUDED.dj_role,
                        max_queue_size = EXCLUDED.max_queue_size,
                        rc_rate_limit_max = EXCLUDED.rc_rate_limit_max,
                        rc_rate_limit_window_ms = EXCLUDED.rc_rate_limit_window_ms,
                        rc_exclusions_json = EXCLUDED.rc_exclusions_json,
                        updated_at = NOW()`,
                    [
                        g.id,
                        g.prefix,
                        g.locale,
                        g.dj_enabled === 1,
                        g.dj_role,
                        g.max_queue_size,
                        g.rc_rate_limit_max,
                        g.rc_rate_limit_window_ms,
                        JSON.stringify(buildExclusions(g.rc_exclusions_json)),
                    ],
                );
                counts.guilds++;
            }

            for (const r of d.request_channels) {
                await client.query(
                    `INSERT INTO request_channels (guild_id, bot_id, channel_id, message_id, updated_at)
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                        channel_id = EXCLUDED.channel_id,
                        message_id = EXCLUDED.message_id,
                        updated_at = NOW()`,
                    [r.guild_id, r.bot_id, r.channel_id, r.message_id],
                );
                counts.request_channels++;
            }

            for (const p of d.player_states) {
                await client.query(
                    `INSERT INTO player_states (guild_id, bot_id, loop_mode, shuffle, autoplay, volume, quality_profile, normalize_audio, filters_json, equalizer_json, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, NOW())
                     ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                        loop_mode = EXCLUDED.loop_mode,
                        shuffle = EXCLUDED.shuffle,
                        autoplay = EXCLUDED.autoplay,
                        volume = EXCLUDED.volume,
                        quality_profile = EXCLUDED.quality_profile,
                        normalize_audio = EXCLUDED.normalize_audio,
                        filters_json = EXCLUDED.filters_json,
                        equalizer_json = EXCLUDED.equalizer_json,
                        updated_at = NOW()`,
                    [
                        p.guild_id,
                        p.bot_id,
                        p.loop_mode,
                        p.shuffle === 1,
                        p.autoplay === 1,
                        p.volume,
                        p.quality_profile,
                        p.normalize_audio === 1,
                        p.filters_json || "{}",
                        p.equalizer_json || "[]",
                    ],
                );
                counts.player_states++;
            }

            for (const { qs, tracks } of parsedQueues) {
                await client.query(
                    `INSERT INTO queue_sessions (guild_id, bot_id, voice_channel_id, text_channel_id, current_track_key, position_ms, paused, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
                     ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                        voice_channel_id = EXCLUDED.voice_channel_id,
                        text_channel_id = EXCLUDED.text_channel_id,
                        current_track_key = EXCLUDED.current_track_key,
                        position_ms = EXCLUDED.position_ms,
                        paused = EXCLUDED.paused,
                        updated_at = NOW()`,
                    [
                        qs.guild_id,
                        qs.bot_id,
                        qs.voice_channel_id,
                        qs.text_channel_id,
                        qs.current_song_key,
                        qs.position_ms,
                        qs.paused === 1,
                    ],
                );
                await client.query("DELETE FROM queue_tracks WHERE guild_id = $1 AND bot_id = $2", [
                    qs.guild_id,
                    qs.bot_id,
                ]);
                if (tracks.length > 0) {
                    const keys = tracks.map((t) => t.key);
                    const positions = tracks.map((_, idx) => idx);
                    const jsons = tracks.map((t) => JSON.stringify(t.track));
                    const reqIds = tracks.map((t) => t.requesterId);
                    const reqTags = tracks.map((t) => t.requesterTag ?? null);
                    const addedAts = tracks.map((t) => Math.floor(t.addedAt));

                    await client.query(
                        `INSERT INTO queue_tracks (guild_id, bot_id, track_key, position, track_json, requester_id, requester_tag, added_at)
                         SELECT $1, $2, k, pos, tj::jsonb, req, tag, added
                         FROM UNNEST($3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::bigint[])
                         AS u(k, pos, tj, req, tag, added)`,
                        [qs.guild_id, qs.bot_id, keys, positions, jsons, reqIds, reqTags, addedAts],
                    );
                }
                counts.queue_states++;
            }

            for (const v of d.voice_channel_status_states) {
                await client.query(
                    `INSERT INTO voice_channel_status_states (guild_id, bot_id, channel_id, status_set, updated_at)
                     VALUES ($1, $2, $3, $4, NOW())
                     ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                        channel_id = EXCLUDED.channel_id,
                        status_set = EXCLUDED.status_set,
                        updated_at = NOW()`,
                    [v.guild_id, v.bot_id, v.channel_id, v.status_set === 1],
                );
                counts.voice_channel_status_states++;
            }

            for (const c of d.cookies_state) {
                await client.query(
                    `INSERT INTO auth_sessions (id, provider, status, email, visitor_data, cookie_hash, last_refresh, error, updated_at)
                     VALUES ($1, 'google_youtube', $2, $3, $4, $5, $6, NULL, NOW())
                     ON CONFLICT (id) DO UPDATE SET
                        status = EXCLUDED.status,
                        email = COALESCE(EXCLUDED.email, auth_sessions.email),
                        visitor_data = COALESCE(EXCLUDED.visitor_data, auth_sessions.visitor_data),
                        cookie_hash = EXCLUDED.cookie_hash,
                        last_refresh = EXCLUDED.last_refresh,
                        updated_at = NOW()`,
                    [
                        c.id,
                        normalizeAuthStatus(c.status),
                        c.email ?? null,
                        c.visitor_data ?? null,
                        c.cookie_hash,
                        c.last_refresh,
                    ],
                );
                counts.cookies_state++;
            }

            for (const b of d.bot_settings) {
                await client.query(
                    `INSERT INTO bot_settings (key, value, updated_at)
                     VALUES ($1, $2, NOW())
                     ON CONFLICT (key) DO UPDATE SET
                        value = EXCLUDED.value,
                        updated_at = NOW()`,
                    [b.key, b.value],
                );
                counts.bot_settings++;
            }

            await client.query("COMMIT");
            return { counts };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }
    }

    if (clearExisting) {
        const existingGuilds = await store.listKnownGuildIds();
        for (const gid of existingGuilds) {
            await store.deleteGuildData(gid);
        }
        await store.resetBotSettings(true);
    }

    for (const g of d.guilds) {
        await store.setGuildPrefix(g.id, g.prefix);
        await store.setGuildLocale(g.id, g.locale);
        await store.setGuildDj(g.id, g.dj_enabled === 1, g.dj_role);
        await store.setGuildLimits(g.id, {
            maxQueueSize: g.max_queue_size,
            rcRateLimitMax: g.rc_rate_limit_max,
            rcRateLimitWindowMs: g.rc_rate_limit_window_ms,
            rcExclusions: buildExclusions(g.rc_exclusions_json),
        });
        counts.guilds++;
    }

    for (const r of d.request_channels) {
        await store.setRequestChannel({
            guildId: r.guild_id,
            botId: r.bot_id,
            channelId: r.channel_id,
            messageId: r.message_id,
        });
        counts.request_channels++;
    }

    for (const p of d.player_states) {
        await store.savePlayerState(p.guild_id, p.bot_id, {
            loopMode: normalizeLoopMode(p.loop_mode),
            shuffle: p.shuffle === 1,
            autoplay: p.autoplay === 1,
            volume: p.volume,
            qualityProfile:
                p.quality_profile === "balanced" || p.quality_profile === "low-bandwidth"
                    ? p.quality_profile
                    : "fidelity",
            normalizeAudio: p.normalize_audio === 1,
            filters: parseJsonSafe(p.filters_json, {}),
            equalizer: parseJsonSafe(p.equalizer_json, []),
        });
        counts.player_states++;
    }

    for (const { qs, tracks } of parsedQueues) {
        await store.saveQueueSession({
            guildId: qs.guild_id,
            botId: qs.bot_id,
            voiceChannelId: qs.voice_channel_id,
            textChannelId: qs.text_channel_id,
            currentTrackKey: qs.current_song_key,
            positionMs: qs.position_ms,
            paused: qs.paused === 1,
            tracks,
        });
        counts.queue_states++;
    }

    for (const v of d.voice_channel_status_states) {
        await store.saveVoiceChannelStatus({
            guildId: v.guild_id,
            botId: v.bot_id,
            channelId: v.channel_id,
            statusSet: v.status_set === 1,
        });
        counts.voice_channel_status_states++;
    }

    for (const c of d.cookies_state) {
        await store.saveAuthSession({
            id: c.id,
            email: c.email ?? null,
            visitorData: c.visitor_data ?? null,
            cookieHash: c.cookie_hash,
            lastRefresh: c.last_refresh,
            status: normalizeAuthStatus(c.status),
        });
        counts.cookies_state++;
    }

    for (const b of d.bot_settings) {
        await store.setBotSetting(b.key, b.value);
        counts.bot_settings++;
    }

    return { counts };
}

export async function importFromLegacySqlite(
    store: DatabaseStore,
    sqliteFilePath: string,
    options?: { clearExisting?: boolean },
): Promise<{ counts: MigrationImportCounts; warnings: string[] }> {
    if (!existsSync(sqliteFilePath)) {
        throw new ValidationError(`Legacy SQLite file not found: ${sqliteFilePath}`);
    }

    const db = new DatabaseSync(sqliteFilePath, { readOnly: true });
    const warnings: string[] = [];

    try {
        const tableRows = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>;
        const existingTables = new Set(tableRows.map((r) => r.name));

        const readTable = <T extends Record<string, unknown>>(tableName: string): T[] => {
            if (!existingTables.has(tableName)) {
                warnings.push(`Legacy table '${tableName}' not found; skipped.`);
                return [];
            }
            return db.prepare(`SELECT * FROM ${tableName}`).all() as T[];
        };

        const rawBundle = {
            version: "1.0.0" as const,
            exportedAt: new Date().toISOString(),
            data: {
                guilds: readTable("guilds"),
                request_channels: readTable("request_channels"),
                player_states: readTable("player_states"),
                queue_states: readTable("queue_states"),
                voice_channel_status_states: readTable("voice_channel_status_states"),
                cookies_state: readTable("cookies_state"),
                bot_settings: readTable("bot_settings"),
            },
        };

        const result = await importDatabaseBundle(store, rawBundle, options);
        return { ...result, warnings };
    } finally {
        db.close();
    }
}

export async function importFromJsonFile(
    store: DatabaseStore,
    jsonFilePath: string,
    options?: { clearExisting?: boolean },
): Promise<{ counts: MigrationImportCounts }> {
    if (!existsSync(jsonFilePath)) {
        throw new ValidationError(`JSON import file not found: ${jsonFilePath}`);
    }
    const content = readFileSync(jsonFilePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    return importDatabaseBundle(store, parsed, options);
}
