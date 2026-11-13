import {
    BOT_SETTINGS_DEFAULTS,
    createDefaultGuildConfig,
    createDefaultPlayerState,
} from "@rawon/config";
import type {
    AuthSessionRecord,
    BotSettings,
    GuildConfig,
    PersistedQueueSession,
    PlayerState,
    RequestChannelConfig,
    VoiceChannelStatusState,
} from "@rawon/shared";
import type { DatabaseStore } from "./interfaces.js";

function key2(guildId: string, botId: string): string {
    return `${guildId}:${botId}`;
}

export function buildBotSettingsFromRaw(raw: Record<string, string | null>): BotSettings {
    const out: BotSettings = { ...BOT_SETTINGS_DEFAULTS };
    if (raw.embed_color) out.embedColor = raw.embed_color;
    if (raw.yes_emoji) out.yesEmoji = raw.yes_emoji;
    if (raw.no_emoji) out.noEmoji = raw.no_emoji;
    if (raw.alt_prefix !== undefined && raw.alt_prefix !== null) {
        out.altPrefix = raw.alt_prefix
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
    }
    if (raw.request_channel_splash) out.requestChannelSplash = raw.request_channel_splash;
    if (raw.default_volume !== undefined && raw.default_volume !== null) {
        const vol = Number(raw.default_volume);
        if (Number.isFinite(vol) && vol >= 1 && vol <= 200) out.defaultVolume = vol;
    }
    if (raw.music_selection_type === "message" || raw.music_selection_type === "selectmenu") {
        out.musicSelectionType = raw.music_selection_type;
    }
    if (raw.search_provider === "dsp" || raw.search_provider === "direct") {
        out.searchProvider = raw.search_provider;
    }
    if (raw.always_on !== undefined && raw.always_on !== null) {
        out.alwaysOn = raw.always_on === "1" || raw.always_on === "true";
    }
    if (raw.enable_audio_cache !== undefined && raw.enable_audio_cache !== null) {
        out.enableAudioCache = raw.enable_audio_cache !== "0" && raw.enable_audio_cache !== "false";
    }
    if (
        raw.default_quality_profile === "fidelity" ||
        raw.default_quality_profile === "balanced" ||
        raw.default_quality_profile === "low-bandwidth"
    ) {
        out.defaultQualityProfile = raw.default_quality_profile;
    }
    if (raw.default_normalize_audio !== undefined && raw.default_normalize_audio !== null) {
        out.defaultNormalizeAudio =
            raw.default_normalize_audio === "1" || raw.default_normalize_audio === "true";
    }
    return out;
}

export class MemoryDatabaseStore implements DatabaseStore {
    private readonly guilds = new Map<string, GuildConfig>();
    private readonly rawSettings = new Map<string, string>();
    private readonly requestChannels = new Map<string, RequestChannelConfig>();
    private readonly playerStates = new Map<string, PlayerState>();
    private readonly queueSessions = new Map<string, PersistedQueueSession>();
    private readonly voiceStatuses = new Map<string, VoiceChannelStatusState>();
    private authSession: AuthSessionRecord = {
        id: 1,
        provider: "google_youtube",
        status: "idle",
        email: null,
        visitorData: null,
        cookieHash: null,
        lastRefresh: null,
        error: null,
    };

    public async initialize(): Promise<void> {}
    public async close(): Promise<void> {}

    public async getGuildConfig(guildId: string): Promise<GuildConfig> {
        return structuredClone(this.guilds.get(guildId) ?? createDefaultGuildConfig(guildId));
    }

    public async setGuildPrefix(guildId: string, prefix: string | null): Promise<GuildConfig> {
        const cur = await this.getGuildConfig(guildId);
        cur.prefix = prefix;
        this.guilds.set(guildId, cur);
        return structuredClone(cur);
    }

    public async setGuildLocale(guildId: string, locale: string | null): Promise<GuildConfig> {
        const cur = await this.getGuildConfig(guildId);
        cur.locale = locale;
        this.guilds.set(guildId, cur);
        return structuredClone(cur);
    }

    public async setGuildDj(
        guildId: string,
        djEnabled: boolean,
        djRoleId: string | null,
    ): Promise<GuildConfig> {
        const cur = await this.getGuildConfig(guildId);
        cur.djEnabled = djEnabled;
        cur.djRoleId = djRoleId;
        this.guilds.set(guildId, cur);
        return structuredClone(cur);
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
        Object.assign(cur, updates);
        this.guilds.set(guildId, cur);
        return structuredClone(cur);
    }

    public async deleteGuildData(guildId: string): Promise<void> {
        this.guilds.delete(guildId);
        for (const k of [...this.requestChannels.keys()]) {
            if (k.startsWith(`${guildId}:`)) this.requestChannels.delete(k);
        }
        for (const k of [...this.playerStates.keys()]) {
            if (k.startsWith(`${guildId}:`)) this.playerStates.delete(k);
        }
        for (const k of [...this.queueSessions.keys()]) {
            if (k.startsWith(`${guildId}:`)) this.queueSessions.delete(k);
        }
        for (const k of [...this.voiceStatuses.keys()]) {
            if (k.startsWith(`${guildId}:`)) this.voiceStatuses.delete(k);
        }
    }

    public async listKnownGuildIds(): Promise<string[]> {
        const set = new Set<string>(this.guilds.keys());
        for (const rc of this.requestChannels.values()) set.add(rc.guildId);
        for (const qs of this.queueSessions.values()) set.add(qs.guildId);
        for (const vs of this.voiceStatuses.values()) set.add(vs.guildId);
        return [...set];
    }

    public async getBotSettings(): Promise<BotSettings> {
        return buildBotSettingsFromRaw(await this.getRawBotSettings());
    }

    public async setBotSetting(key: string, value: string | null): Promise<BotSettings> {
        if (value === null) {
            this.rawSettings.delete(key);
        } else {
            this.rawSettings.set(key, value);
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
        for (const key of keys) {
            this.rawSettings.delete(key);
        }
        return this.getBotSettings();
    }

    public async getRawBotSettings(): Promise<Record<string, string | null>> {
        const out: Record<string, string | null> = {};
        for (const [k, v] of this.rawSettings.entries()) out[k] = v;
        return out;
    }

    public async getRequestChannel(
        guildId: string,
        botId: string,
    ): Promise<RequestChannelConfig | null> {
        const val = this.requestChannels.get(key2(guildId, botId));
        return val ? structuredClone(val) : null;
    }

    public async getRequestChannelsForGuild(guildId: string): Promise<RequestChannelConfig[]> {
        return [...this.requestChannels.values()]
            .filter((r) => r.guildId === guildId)
            .map((r) => structuredClone(r));
    }

    public async getAllRequestChannelsForBot(botId: string): Promise<RequestChannelConfig[]> {
        return [...this.requestChannels.values()]
            .filter((r) => r.botId === botId)
            .map((r) => structuredClone(r));
    }

    public async setRequestChannel(config: RequestChannelConfig): Promise<void> {
        this.requestChannels.set(key2(config.guildId, config.botId), structuredClone(config));
    }

    public async deleteRequestChannel(guildId: string, botId: string): Promise<void> {
        this.requestChannels.delete(key2(guildId, botId));
    }

    public async getPlayerState(guildId: string, botId: string): Promise<PlayerState> {
        const existing = this.playerStates.get(key2(guildId, botId));
        if (existing) return structuredClone(existing);
        return createDefaultPlayerState(await this.getBotSettings());
    }

    public async savePlayerState(
        guildId: string,
        botId: string,
        state: PlayerState,
    ): Promise<void> {
        this.playerStates.set(key2(guildId, botId), structuredClone(state));
    }

    public async getQueueSession(
        guildId: string,
        botId: string,
    ): Promise<PersistedQueueSession | null> {
        const val = this.queueSessions.get(key2(guildId, botId));
        return val ? structuredClone(val) : null;
    }

    public async listQueueSessionsForBot(botId: string): Promise<PersistedQueueSession[]> {
        return [...this.queueSessions.values()]
            .filter((q) => q.botId === botId)
            .map((q) => structuredClone(q));
    }

    public async saveQueueSession(session: PersistedQueueSession): Promise<void> {
        this.queueSessions.set(key2(session.guildId, session.botId), structuredClone(session));
    }

    public async updateQueuePosition(
        guildId: string,
        botId: string,
        currentTrackKey: string | null,
        positionMs: number,
        paused: boolean,
    ): Promise<void> {
        const existing = this.queueSessions.get(key2(guildId, botId));
        if (!existing) return;
        existing.currentTrackKey = currentTrackKey;
        existing.positionMs = positionMs;
        existing.paused = paused;
    }

    public async deleteQueueSession(guildId: string, botId: string): Promise<void> {
        this.queueSessions.delete(key2(guildId, botId));
    }

    public async getVoiceChannelStatus(
        guildId: string,
        botId: string,
    ): Promise<VoiceChannelStatusState | null> {
        const val = this.voiceStatuses.get(key2(guildId, botId));
        return val ? structuredClone(val) : null;
    }

    public async listVoiceChannelStatusesForBot(botId: string): Promise<VoiceChannelStatusState[]> {
        return [...this.voiceStatuses.values()]
            .filter((v) => v.botId === botId)
            .map((v) => structuredClone(v));
    }

    public async saveVoiceChannelStatus(state: VoiceChannelStatusState): Promise<void> {
        this.voiceStatuses.set(key2(state.guildId, state.botId), structuredClone(state));
    }

    public async deleteVoiceChannelStatus(guildId: string, botId: string): Promise<void> {
        this.voiceStatuses.delete(key2(guildId, botId));
    }

    public async getAuthSession(id = 1): Promise<AuthSessionRecord> {
        return { ...this.authSession, id };
    }

    public async saveAuthSession(
        record: Partial<AuthSessionRecord> & { id?: number },
    ): Promise<AuthSessionRecord> {
        this.authSession = { ...this.authSession, ...record, id: record.id ?? 1 };
        return { ...this.authSession };
    }

    public async exportSnapshot() {
        const playerRows = [];
        for (const [k, st] of this.playerStates.entries()) {
            const [guild_id = "", bot_id = ""] = k.split(":");
            playerRows.push({
                guild_id,
                bot_id,
                loop_mode: st.loopMode,
                shuffle: st.shuffle ? 1 : 0,
                autoplay: st.autoplay ? 1 : 0,
                volume: st.volume,
                quality_profile: st.qualityProfile,
                normalize_audio: st.normalizeAudio ? 1 : 0,
                filters_json: JSON.stringify(st.filters),
                equalizer_json: JSON.stringify(st.equalizer),
            });
        }

        const queueRows = [...this.queueSessions.values()].map((q) => ({
            guild_id: q.guildId,
            bot_id: q.botId,
            voice_channel_id: q.voiceChannelId,
            text_channel_id: q.textChannelId,
            current_song_key: q.currentTrackKey,
            position_ms: q.positionMs,
            paused: q.paused ? 1 : 0,
            songs_json: JSON.stringify(q.tracks),
        }));

        return {
            guilds: [...this.guilds.values()].map((g) => ({
                id: g.guildId,
                prefix: g.prefix,
                locale: g.locale,
                dj_enabled: g.djEnabled ? 1 : 0,
                dj_role: g.djRoleId,
                max_queue_size: g.maxQueueSize,
                rc_rate_limit_max: g.rcRateLimitMax,
                rc_rate_limit_window_ms: g.rcRateLimitWindowMs,
                rc_exclusions_json: JSON.stringify(g.rcExclusions),
            })),
            request_channels: [...this.requestChannels.values()].map((r) => ({
                guild_id: r.guildId,
                bot_id: r.botId,
                channel_id: r.channelId,
                message_id: r.messageId,
            })),
            player_states: playerRows,
            queue_states: queueRows,
            voice_channel_status_states: [...this.voiceStatuses.values()].map((v) => ({
                guild_id: v.guildId,
                bot_id: v.botId,
                channel_id: v.channelId,
                status_set: v.statusSet ? 1 : 0,
            })),
            cookies_state: [
                {
                    id: this.authSession.id,
                    last_refresh: this.authSession.lastRefresh,
                    cookie_hash: this.authSession.cookieHash,
                    email: this.authSession.email,
                    visitor_data: this.authSession.visitorData,
                    status: this.authSession.status,
                },
            ],
            bot_settings: [...this.rawSettings.entries()].map(([key, value]) => ({ key, value })),
        };
    }
}
