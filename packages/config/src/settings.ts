import type { BotSettings, GuildConfig, PlayerState, SearchProviderMode } from "@rawon/shared";

export const BOT_SETTINGS_DEFAULTS: BotSettings = {
    embedColor: "7289DA",
    yesEmoji: "✅",
    noEmoji: "❌",
    altPrefix: ["{mention}"],
    requestChannelSplash: "https://cdn.stegripe.org/images/icon.png",
    defaultVolume: 100,
    musicSelectionType: "message",
    searchProvider: "dsp",
    alwaysOn: false,
    enableAudioCache: true,
    defaultQualityProfile: "fidelity",
    defaultNormalizeAudio: false,
};

export function createDefaultPlayerState(
    settings: BotSettings = BOT_SETTINGS_DEFAULTS,
): PlayerState {
    return {
        loopMode: "OFF",
        shuffle: false,
        autoplay: false,
        volume: settings.defaultVolume,
        qualityProfile: settings.defaultQualityProfile,
        normalizeAudio: settings.defaultNormalizeAudio,
        filters: {},
        equalizer: [],
    };
}

export function createDefaultGuildConfig(guildId: string): GuildConfig {
    return {
        guildId,
        prefix: null,
        locale: null,
        djEnabled: false,
        djRoleId: null,
        maxQueueSize: 500,
        rcRateLimitMax: 5,
        rcRateLimitWindowMs: 15_000,
        rcExclusions: {
            ignoredPrefixes: ["!", ".", "?", "//"],
            ignoredUserIds: [],
            ignoredRoleIds: [],
            requireVoiceChannel: true,
            deleteRequestMessages: true,
            deleteFeedbackAfterMs: 60_000,
            allowMultiLineRequests: true,
        },
    };
}

export function normalizeHexColor(value: string): string | null {
    const cleaned = value.trim().replace(/^#/u, "").toUpperCase();
    return /^[0-9A-F]{6}$/u.test(cleaned) ? cleaned : null;
}

export function parseSearchProviderInput(
    input: string | undefined,
): SearchProviderMode | "reset" | null {
    if (!input) {
        return null;
    }
    const normalized = input.trim().toLowerCase();
    if (normalized === "reset") return "reset";
    if (normalized === "dsp" || normalized === "ytm" || normalized === "youtubemusic") return "dsp";
    if (normalized === "direct" || normalized === "yt" || normalized === "youtube") return "direct";
    return null;
}

export function formatSearchProvider(mode: SearchProviderMode): string {
    return mode === "dsp" ? "DSP (YouTube Music)" : "Direct (YouTube)";
}
