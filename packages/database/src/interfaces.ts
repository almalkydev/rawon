import type {
    AuthSessionRecord,
    BotSettings,
    GuildConfig,
    PersistedQueueSession,
    PlayerState,
    RequestChannelConfig,
    VoiceChannelStatusState,
} from "@rawon/shared";

export interface BotHeartbeatInfo {
    botId: string;
    tokenIndex: number;
    tag: string;
    guildIds: string[];
    activeVoiceSessions: number;
    updatedAt: number;
}

export interface RateLimitCheckResult {
    allowed: boolean;
    remaining: number;
    retryAfterMs: number;
}

export interface DatabaseStore {
    initialize(): Promise<void>;
    close(): Promise<void>;

    // Guild configuration
    getGuildConfig(guildId: string): Promise<GuildConfig>;
    setGuildPrefix(guildId: string, prefix: string | null): Promise<GuildConfig>;
    setGuildLocale(guildId: string, locale: string | null): Promise<GuildConfig>;
    setGuildDj(guildId: string, djEnabled: boolean, djRoleId: string | null): Promise<GuildConfig>;
    setGuildLimits(
        guildId: string,
        updates: Partial<
            Pick<
                GuildConfig,
                "maxQueueSize" | "rcRateLimitMax" | "rcRateLimitWindowMs" | "rcExclusions"
            >
        >,
    ): Promise<GuildConfig>;
    deleteGuildData(guildId: string): Promise<void>;
    listKnownGuildIds(): Promise<string[]>;

    // Bot settings
    getBotSettings(): Promise<BotSettings>;
    setBotSetting(key: string, value: string | null): Promise<BotSettings>;
    resetBotSettings(includeAlwaysOn?: boolean): Promise<BotSettings>;
    getRawBotSettings(): Promise<Record<string, string | null>>;

    // Request channels
    getRequestChannel(guildId: string, botId: string): Promise<RequestChannelConfig | null>;
    getRequestChannelsForGuild(guildId: string): Promise<RequestChannelConfig[]>;
    getAllRequestChannelsForBot(botId: string): Promise<RequestChannelConfig[]>;
    setRequestChannel(config: RequestChannelConfig): Promise<void>;
    deleteRequestChannel(guildId: string, botId: string): Promise<void>;

    // Player states
    getPlayerState(guildId: string, botId: string): Promise<PlayerState>;
    savePlayerState(guildId: string, botId: string, state: PlayerState): Promise<void>;

    // Queue sessions
    getQueueSession(guildId: string, botId: string): Promise<PersistedQueueSession | null>;
    listQueueSessionsForBot(botId: string): Promise<PersistedQueueSession[]>;
    saveQueueSession(session: PersistedQueueSession): Promise<void>;
    updateQueuePosition(
        guildId: string,
        botId: string,
        currentTrackKey: string | null,
        positionMs: number,
        paused: boolean,
    ): Promise<void>;
    deleteQueueSession(guildId: string, botId: string): Promise<void>;

    // Voice channel statuses
    getVoiceChannelStatus(guildId: string, botId: string): Promise<VoiceChannelStatusState | null>;
    listVoiceChannelStatusesForBot(botId: string): Promise<VoiceChannelStatusState[]>;
    saveVoiceChannelStatus(state: VoiceChannelStatusState): Promise<void>;
    deleteVoiceChannelStatus(guildId: string, botId: string): Promise<void>;

    // Auth / Cookies metadata
    getAuthSession(id?: number): Promise<AuthSessionRecord>;
    saveAuthSession(
        record: Partial<AuthSessionRecord> & { id?: number },
    ): Promise<AuthSessionRecord>;

    // Export / Import helper snapshot
    exportSnapshot(): Promise<{
        guilds: Array<{
            id: string;
            prefix: string | null;
            locale: string | null;
            dj_enabled: number;
            dj_role: string | null;
            max_queue_size: number;
            rc_rate_limit_max: number;
            rc_rate_limit_window_ms: number;
            rc_exclusions_json: string;
        }>;
        request_channels: Array<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            message_id: string | null;
        }>;
        player_states: Array<{
            guild_id: string;
            bot_id: string;
            loop_mode: string;
            shuffle: number;
            autoplay: number;
            volume: number;
            quality_profile: string;
            normalize_audio: number;
            filters_json: string;
            equalizer_json: string;
        }>;
        queue_states: Array<{
            guild_id: string;
            bot_id: string;
            voice_channel_id: string;
            text_channel_id: string;
            current_song_key: string | null;
            position_ms: number;
            paused: number;
            songs_json: string;
        }>;
        voice_channel_status_states: Array<{
            guild_id: string;
            bot_id: string;
            channel_id: string;
            status_set: number;
        }>;
        cookies_state: Array<{
            id: number;
            last_refresh: number | null;
            cookie_hash: string | null;
            email?: string | null;
            visitor_data?: string | null;
            status?: string | null;
        }>;
        bot_settings: Array<{ key: string; value: string | null }>;
    }>;
}

export interface CoordinatorEvent {
    type: "settings_updated" | "guild_updated" | "failover" | "precache_request";
    payload: Record<string, unknown>;
    originBotId?: string;
    timestamp: number;
}

export interface CoordinatorService {
    connect(): Promise<void>;
    close(): Promise<void>;
    registerBotHeartbeat(info: BotHeartbeatInfo, ttlMs?: number): Promise<void>;
    listActiveBots(): Promise<BotHeartbeatInfo[]>;
    electPrimaryBot(guildId: string, presentBots: BotHeartbeatInfo[]): Promise<string | null>;
    acquireVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs?: number,
    ): Promise<boolean>;
    renewVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs?: number,
    ): Promise<boolean>;
    releaseVoiceOwnership(guildId: string, channelId: string, botId: string): Promise<void>;
    getVoiceOwner(guildId: string, channelId: string): Promise<string | null>;
    checkRateLimit(
        scopeKey: string,
        maxRequests: number,
        windowMs: number,
    ): Promise<RateLimitCheckResult>;
    publishEvent(event: CoordinatorEvent): Promise<void>;
    onEvent(handler: (event: CoordinatorEvent) => void): () => void;
}
