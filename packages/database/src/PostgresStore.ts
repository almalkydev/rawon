import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDefaultGuildConfig, createDefaultPlayerState } from "@rawon/config";
import type {
    AuthSessionRecord,
    BotSettings,
    GuildConfig,
    Logger,
    PersistedQueueSession,
    PlayerState,
    QueuedTrack,
    RequestChannelConfig,
    VoiceChannelStatusState,
} from "@rawon/shared";
import pg from "pg";
import type { DatabaseStore } from "./interfaces.js";
import { buildBotSettingsFromRaw } from "./MemoryStore.js";

const { Pool } = pg;

export class PostgresDatabaseStore implements DatabaseStore {
    private readonly pool: pg.Pool;
    private readonly logger?: Logger;
    private readonly migrationsDir: string;

    public constructor(options: {
        connectionString: string;
        maxConnections?: number;
        logger?: Logger;
        migrationsDir?: string;
    }) {
        this.logger = options.logger;
        this.migrationsDir = options.migrationsDir ?? resolve(import.meta.dirname, "../migrations");
        this.pool = new Pool({
            connectionString: options.connectionString,
            max: options.maxConnections ?? 15,
            idleTimeoutMillis: 30_000,
            connectionTimeoutMillis: 10_000,
        });
        this.pool.on("error", (err) => {
            this.logger?.error({ err }, "Unexpected PostgreSQL idle client error");
        });
    }

    public getPool(): pg.Pool {
        return this.pool;
    }

    public async initialize(): Promise<void> {
        await this.runMigrations();
    }

    public async runMigrations(): Promise<number> {
        if (!existsSync(this.migrationsDir)) {
            return 0;
        }
        const files = readdirSync(this.migrationsDir)
            .filter((f) => /^\d+_.*\.sql$/u.test(f))
            .sort();

        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        `);

        let applied = 0;
        for (const file of files) {
            const versionMatch = /^(\d+)_/u.exec(file);
            if (!versionMatch) continue;
            const version = Number.parseInt(versionMatch[1] ?? "0", 10);

            const check = await this.pool.query<{ version: number }>(
                "SELECT version FROM schema_migrations WHERE version = $1",
                [version],
            );
            if (check.rowCount && check.rowCount > 0) {
                continue;
            }

            const sql = readFileSync(resolve(this.migrationsDir, file), "utf8");
            const client = await this.pool.connect();
            try {
                await client.query("BEGIN");
                await client.query(sql);
                await client.query(
                    "INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING",
                    [version, file],
                );
                await client.query("COMMIT");
                applied += 1;
                this.logger?.info({ version, file }, "Applied PostgreSQL migration");
            } catch (err) {
                await client.query("ROLLBACK");
                throw err;
            } finally {
                client.release();
            }
        }
        return applied;
    }

    public async close(): Promise<void> {
        await this.pool.end();
    }

    public async getGuildConfig(guildId: string): Promise<GuildConfig> {
        const defaults = createDefaultGuildConfig(guildId);
        const res = await this.pool.query<{
            guild_id: string;
            prefix: string | null;
            locale: string | null;
            dj_enabled: boolean;
            dj_role_id: string | null;
            max_queue_size: number;
            rc_rate_limit_max: number;
            rc_rate_limit_window_ms: number;
            rc_exclusions_json: Partial<GuildConfig["rcExclusions"]>;
        }>("SELECT * FROM guilds WHERE guild_id = $1", [guildId]);

        const row = res.rows[0];
        if (!row) return defaults;

        return {
            guildId: row.guild_id,
            prefix: row.prefix,
            locale: row.locale,
            djEnabled: Boolean(row.dj_enabled),
            djRoleId: row.dj_role_id,
            maxQueueSize: row.max_queue_size || defaults.maxQueueSize,
            rcRateLimitMax: row.rc_rate_limit_max || defaults.rcRateLimitMax,
            rcRateLimitWindowMs: row.rc_rate_limit_window_ms || defaults.rcRateLimitWindowMs,
            rcExclusions: { ...defaults.rcExclusions, ...(row.rc_exclusions_json ?? {}) },
        };
    }

    public async setGuildPrefix(guildId: string, prefix: string | null): Promise<GuildConfig> {
        await this.pool.query(
            `INSERT INTO guilds (guild_id, prefix, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (guild_id) DO UPDATE SET prefix = EXCLUDED.prefix, updated_at = NOW()`,
            [guildId, prefix],
        );
        return this.getGuildConfig(guildId);
    }

    public async setGuildLocale(guildId: string, locale: string | null): Promise<GuildConfig> {
        await this.pool.query(
            `INSERT INTO guilds (guild_id, locale, updated_at) VALUES ($1, $2, NOW())
             ON CONFLICT (guild_id) DO UPDATE SET locale = EXCLUDED.locale, updated_at = NOW()`,
            [guildId, locale],
        );
        return this.getGuildConfig(guildId);
    }

    public async setGuildDj(
        guildId: string,
        djEnabled: boolean,
        djRoleId: string | null,
    ): Promise<GuildConfig> {
        await this.pool.query(
            `INSERT INTO guilds (guild_id, dj_enabled, dj_role_id, updated_at) VALUES ($1, $2, $3, NOW())
             ON CONFLICT (guild_id) DO UPDATE SET dj_enabled = EXCLUDED.dj_enabled, dj_role_id = EXCLUDED.dj_role_id, updated_at = NOW()`,
            [guildId, djEnabled, djRoleId],
        );
        return this.getGuildConfig(guildId);
    }

    public async setGuildLimits(
        guildId: string,
        updates: Partial<
            Pick<
                GuildConfig,
                "maxQueueSize" | "rcRateLimitMax" | "rcRateLimitWindowMs" | "rcExclusions"
            >
        >,
    ): Promise<GuildConfig> {
        const cur = await this.getGuildConfig(guildId);
        const merged = { ...cur, ...updates };
        await this.pool.query(
            `INSERT INTO guilds (guild_id, max_queue_size, rc_rate_limit_max, rc_rate_limit_window_ms, rc_exclusions_json, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
             ON CONFLICT (guild_id) DO UPDATE SET
                max_queue_size = EXCLUDED.max_queue_size,
                rc_rate_limit_max = EXCLUDED.rc_rate_limit_max,
                rc_rate_limit_window_ms = EXCLUDED.rc_rate_limit_window_ms,
                rc_exclusions_json = EXCLUDED.rc_exclusions_json,
                updated_at = NOW()`,
            [
                guildId,
                merged.maxQueueSize,
                merged.rcRateLimitMax,
                merged.rcRateLimitWindowMs,
                JSON.stringify(merged.rcExclusions),
            ],
        );
        return merged;
    }

    public async deleteGuildData(guildId: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM queue_tracks WHERE guild_id = $1", [guildId]);
            await client.query("DELETE FROM queue_sessions WHERE guild_id = $1", [guildId]);
            await client.query("DELETE FROM player_states WHERE guild_id = $1", [guildId]);
            await client.query("DELETE FROM request_channels WHERE guild_id = $1", [guildId]);
            await client.query("DELETE FROM voice_channel_status_states WHERE guild_id = $1", [
                guildId,
            ]);
            await client.query("DELETE FROM guilds WHERE guild_id = $1", [guildId]);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    public async listKnownGuildIds(): Promise<string[]> {
        const res = await this.pool.query<{ guild_id: string }>(`
            SELECT guild_id FROM guilds
            UNION SELECT guild_id FROM request_channels
            UNION SELECT guild_id FROM queue_sessions
            UNION SELECT guild_id FROM voice_channel_status_states
        `);
        return res.rows.map((r) => r.guild_id);
    }

    public async getBotSettings(): Promise<BotSettings> {
        return buildBotSettingsFromRaw(await this.getRawBotSettings());
    }

    public async setBotSetting(key: string, value: string | null): Promise<BotSettings> {
        if (value === null) {
            await this.pool.query("DELETE FROM bot_settings WHERE key = $1", [key]);
        } else {
            await this.pool.query(
                `INSERT INTO bot_settings (key, value, updated_at) VALUES ($1, $2, NOW())
                 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
                [key, value],
            );
        }
        return this.getBotSettings();
    }

    public async resetBotSettings(includeAlwaysOn = true): Promise<BotSettings> {
        const keys = [
            "embed_color",
            "yes_emoji",
            "no_emoji",
            "alt_prefix",
            "request_channel_splash",
            "default_volume",
            "music_selection_type",
            "search_provider",
            "enable_audio_cache",
            "default_quality_profile",
            "default_normalize_audio",
        ];
        if (includeAlwaysOn) keys.push("always_on");
        await this.pool.query("DELETE FROM bot_settings WHERE key = ANY($1::text[])", [keys]);
        return this.getBotSettings();
    }

    public async getRawBotSettings(): Promise<Record<string, string | null>> {
        const res = await this.pool.query<{ key: string; value: string | null }>(
            "SELECT key, value FROM bot_settings",
        );
        const out: Record<string, string | null> = {};
        for (const row of res.rows) {
            out[row.key] = row.value;
        }
        return out;
    }

    public async getRequestChannel(
        guildId: string,
        botId: string,
    ): Promise<RequestChannelConfig | null> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            message_id: string | null;
        }>(
            "SELECT guild_id, bot_id, channel_id, message_id FROM request_channels WHERE guild_id = $1 AND bot_id = $2",
            [guildId, botId],
        );
        const row = res.rows[0];
        return row
            ? {
                  guildId: row.guild_id,
                  botId: row.bot_id,
                  channelId: row.channel_id,
                  messageId: row.message_id,
              }
            : null;
    }

    public async getRequestChannelsForGuild(guildId: string): Promise<RequestChannelConfig[]> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            message_id: string | null;
        }>(
            "SELECT guild_id, bot_id, channel_id, message_id FROM request_channels WHERE guild_id = $1",
            [guildId],
        );
        return res.rows.map((r) => ({
            guildId: r.guild_id,
            botId: r.bot_id,
            channelId: r.channel_id,
            messageId: r.message_id,
        }));
    }

    public async getAllRequestChannelsForBot(botId: string): Promise<RequestChannelConfig[]> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            message_id: string | null;
        }>(
            "SELECT guild_id, bot_id, channel_id, message_id FROM request_channels WHERE bot_id = $1",
            [botId],
        );
        return res.rows.map((r) => ({
            guildId: r.guild_id,
            botId: r.bot_id,
            channelId: r.channel_id,
            messageId: r.message_id,
        }));
    }

    public async setRequestChannel(config: RequestChannelConfig): Promise<void> {
        await this.pool.query(
            `INSERT INTO request_channels (guild_id, bot_id, channel_id, message_id, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                channel_id = EXCLUDED.channel_id,
                message_id = EXCLUDED.message_id,
                updated_at = NOW()`,
            [config.guildId, config.botId, config.channelId, config.messageId],
        );
    }

    public async deleteRequestChannel(guildId: string, botId: string): Promise<void> {
        await this.pool.query("DELETE FROM request_channels WHERE guild_id = $1 AND bot_id = $2", [
            guildId,
            botId,
        ]);
    }

    public async getPlayerState(guildId: string, botId: string): Promise<PlayerState> {
        const res = await this.pool.query<{
            loop_mode: PlayerState["loopMode"];
            shuffle: boolean;
            autoplay: boolean;
            volume: number;
            quality_profile: PlayerState["qualityProfile"];
            normalize_audio: boolean;
            filters_json: PlayerState["filters"];
            equalizer_json: PlayerState["equalizer"];
        }>("SELECT * FROM player_states WHERE guild_id = $1 AND bot_id = $2", [guildId, botId]);

        const row = res.rows[0];
        if (!row) {
            return createDefaultPlayerState(await this.getBotSettings());
        }
        return {
            loopMode: row.loop_mode ?? "OFF",
            shuffle: Boolean(row.shuffle),
            autoplay: Boolean(row.autoplay),
            volume: row.volume ?? 100,
            qualityProfile: row.quality_profile ?? "fidelity",
            normalizeAudio: Boolean(row.normalize_audio),
            filters: row.filters_json ?? {},
            equalizer: Array.isArray(row.equalizer_json) ? row.equalizer_json : [],
        };
    }

    public async savePlayerState(
        guildId: string,
        botId: string,
        state: PlayerState,
    ): Promise<void> {
        await this.pool.query(
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
                guildId,
                botId,
                state.loopMode,
                state.shuffle,
                state.autoplay,
                state.volume,
                state.qualityProfile,
                state.normalizeAudio,
                JSON.stringify(state.filters),
                JSON.stringify(state.equalizer),
            ],
        );
    }

    public async getQueueSession(
        guildId: string,
        botId: string,
    ): Promise<PersistedQueueSession | null> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            voice_channel_id: string;
            text_channel_id: string;
            current_track_key: string | null;
            position_ms: string | number;
            paused: boolean;
        }>("SELECT * FROM queue_sessions WHERE guild_id = $1 AND bot_id = $2", [guildId, botId]);
        const row = res.rows[0];
        if (!row) return null;

        const tracksRes = await this.pool.query<{
            track_key: string;
            position: number;
            track_json: QueuedTrack["track"];
            requester_id: string;
            requester_tag: string | null;
            added_at: string | number;
        }>("SELECT * FROM queue_tracks WHERE guild_id = $1 AND bot_id = $2 ORDER BY position ASC", [
            guildId,
            botId,
        ]);

        return {
            guildId: row.guild_id,
            botId: row.bot_id,
            voiceChannelId: row.voice_channel_id,
            textChannelId: row.text_channel_id,
            currentTrackKey: row.current_track_key,
            positionMs: Number(row.position_ms) || 0,
            paused: Boolean(row.paused),
            tracks: tracksRes.rows.map((t) => ({
                key: t.track_key,
                index: t.position,
                track: t.track_json,
                requesterId: t.requester_id,
                requesterTag: t.requester_tag ?? undefined,
                addedAt: Number(t.added_at) || Date.now(),
            })),
        };
    }

    public async listQueueSessionsForBot(botId: string): Promise<PersistedQueueSession[]> {
        const res = await this.pool.query<{ guild_id: string }>(
            "SELECT guild_id FROM queue_sessions WHERE bot_id = $1",
            [botId],
        );
        const sessions: PersistedQueueSession[] = [];
        for (const r of res.rows) {
            const s = await this.getQueueSession(r.guild_id, botId);
            if (s) sessions.push(s);
        }
        return sessions;
    }

    public async saveQueueSession(session: PersistedQueueSession): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
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
                    session.guildId,
                    session.botId,
                    session.voiceChannelId,
                    session.textChannelId,
                    session.currentTrackKey,
                    Math.max(0, Math.floor(session.positionMs)),
                    session.paused,
                ],
            );

            await client.query("DELETE FROM queue_tracks WHERE guild_id = $1 AND bot_id = $2", [
                session.guildId,
                session.botId,
            ]);

            if (session.tracks.length > 0) {
                const keys = session.tracks.map((t) => t.key);
                const positions = session.tracks.map((t) => t.index);
                const jsons = session.tracks.map((t) => JSON.stringify(t.track));
                const requesters = session.tracks.map((t) => t.requesterId);
                const requesterTags = session.tracks.map((t) => t.requesterTag ?? null);
                const addedAts = session.tracks.map((t) => Math.floor(t.addedAt));

                await client.query(
                    `INSERT INTO queue_tracks (guild_id, bot_id, track_key, position, track_json, requester_id, requester_tag, added_at)
                     SELECT $1, $2, k, pos, tj::jsonb, req, tag, added
                     FROM UNNEST($3::text[], $4::int[], $5::text[], $6::text[], $7::text[], $8::bigint[])
                     AS u(k, pos, tj, req, tag, added)`,
                    [
                        session.guildId,
                        session.botId,
                        keys,
                        positions,
                        jsons,
                        requesters,
                        requesterTags,
                        addedAts,
                    ],
                );
            }

            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    public async updateQueuePosition(
        guildId: string,
        botId: string,
        currentTrackKey: string | null,
        positionMs: number,
        paused: boolean,
    ): Promise<void> {
        await this.pool.query(
            `UPDATE queue_sessions
             SET current_track_key = $3, position_ms = $4, paused = $5, updated_at = NOW()
             WHERE guild_id = $1 AND bot_id = $2`,
            [guildId, botId, currentTrackKey, Math.max(0, Math.floor(positionMs)), paused],
        );
    }

    public async deleteQueueSession(guildId: string, botId: string): Promise<void> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("DELETE FROM queue_tracks WHERE guild_id = $1 AND bot_id = $2", [
                guildId,
                botId,
            ]);
            await client.query("DELETE FROM queue_sessions WHERE guild_id = $1 AND bot_id = $2", [
                guildId,
                botId,
            ]);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    public async getVoiceChannelStatus(
        guildId: string,
        botId: string,
    ): Promise<VoiceChannelStatusState | null> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            status_set: boolean;
        }>(
            "SELECT guild_id, bot_id, channel_id, status_set FROM voice_channel_status_states WHERE guild_id = $1 AND bot_id = $2",
            [guildId, botId],
        );
        const r = res.rows[0];
        return r
            ? {
                  guildId: r.guild_id,
                  botId: r.bot_id,
                  channelId: r.channel_id,
                  statusSet: Boolean(r.status_set),
              }
            : null;
    }

    public async listVoiceChannelStatusesForBot(botId: string): Promise<VoiceChannelStatusState[]> {
        const res = await this.pool.query<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            status_set: boolean;
        }>(
            "SELECT guild_id, bot_id, channel_id, status_set FROM voice_channel_status_states WHERE bot_id = $1",
            [botId],
        );
        return res.rows.map((r) => ({
            guildId: r.guild_id,
            botId: r.bot_id,
            channelId: r.channel_id,
            statusSet: Boolean(r.status_set),
        }));
    }

    public async saveVoiceChannelStatus(state: VoiceChannelStatusState): Promise<void> {
        await this.pool.query(
            `INSERT INTO voice_channel_status_states (guild_id, bot_id, channel_id, status_set, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (guild_id, bot_id) DO UPDATE SET
                channel_id = EXCLUDED.channel_id,
                status_set = EXCLUDED.status_set,
                updated_at = NOW()`,
            [state.guildId, state.botId, state.channelId, state.statusSet],
        );
    }

    public async deleteVoiceChannelStatus(guildId: string, botId: string): Promise<void> {
        await this.pool.query(
            "DELETE FROM voice_channel_status_states WHERE guild_id = $1 AND bot_id = $2",
            [guildId, botId],
        );
    }

    public async getAuthSession(id = 1): Promise<AuthSessionRecord> {
        const res = await this.pool.query<{
            id: number;
            provider: string;
            status: AuthSessionRecord["status"];
            email: string | null;
            visitor_data: string | null;
            cookie_hash: string | null;
            last_refresh: string | number | null;
            error: string | null;
        }>("SELECT * FROM auth_sessions WHERE id = $1", [id]);
        const r = res.rows[0];
        if (!r) {
            return {
                id,
                provider: "google_youtube",
                status: "idle",
                email: null,
                visitorData: null,
                cookieHash: null,
                lastRefresh: null,
                error: null,
            };
        }
        return {
            id: r.id,
            provider: r.provider,
            status: r.status,
            email: r.email,
            visitorData: r.visitor_data,
            cookieHash: r.cookie_hash,
            lastRefresh: r.last_refresh ? Number(r.last_refresh) : null,
            error: r.error,
        };
    }

    public async saveAuthSession(
        record: Partial<AuthSessionRecord> & { id?: number },
    ): Promise<AuthSessionRecord> {
        const id = record.id ?? 1;
        const cur = await this.getAuthSession(id);
        const merged: AuthSessionRecord = { ...cur, ...record, id };
        await this.pool.query(
            `INSERT INTO auth_sessions (id, provider, status, email, visitor_data, cookie_hash, last_refresh, error, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (id) DO UPDATE SET
                provider = EXCLUDED.provider,
                status = EXCLUDED.status,
                email = EXCLUDED.email,
                visitor_data = EXCLUDED.visitor_data,
                cookie_hash = EXCLUDED.cookie_hash,
                last_refresh = EXCLUDED.last_refresh,
                error = EXCLUDED.error,
                updated_at = NOW()`,
            [
                merged.id,
                merged.provider,
                merged.status,
                merged.email,
                merged.visitorData,
                merged.cookieHash,
                merged.lastRefresh,
                merged.error,
            ],
        );
        return merged;
    }

    public async exportSnapshot() {
        const [guildsRes, rcRes, psRes, qsRes, qtRes, vsRes, authRes, bsRes] = await Promise.all([
            this.pool.query("SELECT * FROM guilds"),
            this.pool.query(
                "SELECT guild_id, bot_id, channel_id, message_id FROM request_channels",
            ),
            this.pool.query("SELECT * FROM player_states"),
            this.pool.query("SELECT * FROM queue_sessions"),
            this.pool.query("SELECT * FROM queue_tracks ORDER BY position ASC"),
            this.pool.query(
                "SELECT guild_id, bot_id, channel_id, status_set FROM voice_channel_status_states",
            ),
            this.pool.query("SELECT * FROM auth_sessions"),
            this.pool.query("SELECT key, value FROM bot_settings"),
        ]);

        const tracksByKey = new Map<string, QueuedTrack[]>();
        for (const r of qtRes.rows as Array<{
            guild_id: string;
            bot_id: string;
            track_key: string;
            position: number;
            track_json: QueuedTrack["track"];
            requester_id: string;
            requester_tag: string | null;
            added_at: string | number;
        }>) {
            const k = `${r.guild_id}:${r.bot_id}`;
            const list = tracksByKey.get(k) ?? [];
            list.push({
                key: r.track_key,
                index: r.position,
                track: r.track_json,
                requesterId: r.requester_id,
                requesterTag: r.requester_tag ?? undefined,
                addedAt: Number(r.added_at) || Date.now(),
            });
            tracksByKey.set(k, list);
        }

        return {
            guilds: (guildsRes.rows as Array<Record<string, unknown>>).map((g) => ({
                id: String(g.guild_id),
                prefix: (g.prefix as string | null) ?? null,
                locale: (g.locale as string | null) ?? null,
                dj_enabled: g.dj_enabled ? 1 : 0,
                dj_role: (g.dj_role_id as string | null) ?? null,
                max_queue_size: Number(g.max_queue_size ?? 500),
                rc_rate_limit_max: Number(g.rc_rate_limit_max ?? 5),
                rc_rate_limit_window_ms: Number(g.rc_rate_limit_window_ms ?? 15000),
                rc_exclusions_json: JSON.stringify(g.rc_exclusions_json ?? {}),
            })),
            request_channels: (rcRes.rows as Array<Record<string, unknown>>).map((r) => ({
                guild_id: String(r.guild_id),
                bot_id: String(r.bot_id),
                channel_id: String(r.channel_id),
                message_id: (r.message_id as string | null) ?? null,
            })),
            player_states: (psRes.rows as Array<Record<string, unknown>>).map((p) => ({
                guild_id: String(p.guild_id),
                bot_id: String(p.bot_id),
                loop_mode: String(p.loop_mode ?? "OFF"),
                shuffle: p.shuffle ? 1 : 0,
                autoplay: p.autoplay ? 1 : 0,
                volume: Number(p.volume ?? 100),
                quality_profile: String(p.quality_profile ?? "fidelity"),
                normalize_audio: p.normalize_audio ? 1 : 0,
                filters_json: JSON.stringify(p.filters_json ?? {}),
                equalizer_json: JSON.stringify(p.equalizer_json ?? []),
            })),
            queue_states: (qsRes.rows as Array<Record<string, unknown>>).map((q) => {
                const k = `${String(q.guild_id)}:${String(q.bot_id)}`;
                return {
                    guild_id: String(q.guild_id),
                    bot_id: String(q.bot_id),
                    voice_channel_id: String(q.voice_channel_id),
                    text_channel_id: String(q.text_channel_id),
                    current_song_key: (q.current_track_key as string | null) ?? null,
                    position_ms: Number(q.position_ms ?? 0),
                    paused: q.paused ? 1 : 0,
                    songs_json: JSON.stringify(tracksByKey.get(k) ?? []),
                };
            }),
            voice_channel_status_states: (vsRes.rows as Array<Record<string, unknown>>).map(
                (v) => ({
                    guild_id: String(v.guild_id),
                    bot_id: String(v.bot_id),
                    channel_id: String(v.channel_id),
                    status_set: v.status_set ? 1 : 0,
                }),
            ),
            cookies_state: (authRes.rows as Array<Record<string, unknown>>).map((a) => ({
                id: Number(a.id),
                last_refresh: a.last_refresh ? Number(a.last_refresh) : null,
                cookie_hash: (a.cookie_hash as string | null) ?? null,
                email: (a.email as string | null) ?? null,
                visitor_data: (a.visitor_data as string | null) ?? null,
                status: (a.status as string | null) ?? null,
            })),
            bot_settings: (bsRes.rows as Array<{ key: string; value: string | null }>).map((b) => ({
                key: b.key,
                value: b.value,
            })),
        };
    }
}
