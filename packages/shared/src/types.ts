export type LoopMode = "OFF" | "QUEUE" | "SONG";

export type SourceProviderType =
    | "youtube"
    | "youtubemusic"
    | "soundcloud"
    | "spotify"
    | "direct"
    | "attachment"
    | "unknown";

export type AudioQualityProfile = "fidelity" | "balanced" | "low-bandwidth";

export type SearchProviderMode = "dsp" | "direct";

export type MusicSelectionType = "message" | "selectmenu";

export const FILTER_NAMES = [
    "bassboost",
    "nightcore",
    "vaporwave",
    "treble",
    "8d",
    "reverse",
    "surround",
    "haas",
    "phaser",
    "gate",
    "mcompand",
    "flanger",
    "tremolo",
    "karaoke",
    "vibrato",
    "echo",
    "spedup",
    "slowed",
    "reverb",
] as const;

export type FilterName = (typeof FILTER_NAMES)[number];

export type AudioFiltersState = Partial<Record<FilterName, boolean>>;

export interface EqualizerBand {
    frequency: number;
    gainDb: number;
    width?: number;
}

export interface DspOptions {
    filters: AudioFiltersState;
    equalizer: EqualizerBand[];
    normalizeAudio: boolean;
    qualityProfile: AudioQualityProfile;
}

export interface Track {
    id: string;
    title: string;
    url: string;
    playableUrl?: string;
    duration: number;
    thumbnail: string;
    author?: string;
    isLive?: boolean;
    provider: SourceProviderType;
    spotifyId?: string;
    spotifyUrl?: string;
    isrc?: string;
    album?: string;
    resolvedBy?: SourceProviderType;
    headers?: Record<string, string>;
}

export interface PlaylistMetadata {
    title: string;
    url: string;
    thumbnail: string;
    author?: string;
    skippedCount?: number;
    skippedReason?: "unavailable" | "unresolved" | "skipped";
}

export interface QueuedTrack {
    key: string;
    index: number;
    track: Track;
    requesterId: string;
    requesterTag?: string;
    addedAt: number;
}

export interface SearchResult {
    type: "results" | "selection";
    items: Track[];
    playlist?: PlaylistMetadata;
}

export interface StreamDescriptor {
    sourceType: "url" | "ytdlp" | "cache";
    url: string;
    canonicalKey: string;
    container?: string;
    codec?: string;
    sampleRate?: number;
    channels?: number;
    bitrateBps?: number;
    durationSeconds?: number;
    isLive: boolean;
    seekable: boolean;
    directPassthroughEligible: boolean;
    headers?: Record<string, string>;
    cacheFilePath?: string;
    resolvedAt: number;
    expiresAt?: number;
}

export interface LyricsResult {
    song: string | null;
    artist: string | null;
    lyrics: string;
    albumArt: string | null;
    synced: boolean;
    url: string | null;
    source: string;
}

export interface BotSettings {
    embedColor: string;
    yesEmoji: string;
    noEmoji: string;
    altPrefix: string[];
    requestChannelSplash: string;
    defaultVolume: number;
    musicSelectionType: MusicSelectionType;
    searchProvider: SearchProviderMode;
    alwaysOn: boolean;
    enableAudioCache: boolean;
    defaultQualityProfile: AudioQualityProfile;
    defaultNormalizeAudio: boolean;
}

export interface RequestChannelExclusions {
    ignoredPrefixes: string[];
    ignoredUserIds: string[];
    ignoredRoleIds: string[];
    requireVoiceChannel: boolean;
    deleteRequestMessages: boolean;
    deleteFeedbackAfterMs: number;
    allowMultiLineRequests: boolean;
}

export interface GuildConfig {
    guildId: string;
    prefix: string | null;
    locale: string | null;
    djEnabled: boolean;
    djRoleId: string | null;
    maxQueueSize: number;
    rcRateLimitMax: number;
    rcRateLimitWindowMs: number;
    rcExclusions: RequestChannelExclusions;
}

export interface PlayerState {
    loopMode: LoopMode;
    shuffle: boolean;
    autoplay: boolean;
    volume: number;
    qualityProfile: AudioQualityProfile;
    normalizeAudio: boolean;
    filters: AudioFiltersState;
    equalizer: EqualizerBand[];
}

export interface RequestChannelConfig {
    guildId: string;
    botId: string;
    channelId: string;
    messageId: string | null;
}

export interface PersistedQueueSession {
    guildId: string;
    botId: string;
    voiceChannelId: string;
    textChannelId: string;
    currentTrackKey: string | null;
    positionMs: number;
    paused: boolean;
    tracks: QueuedTrack[];
}

export interface VoiceChannelStatusState {
    guildId: string;
    botId: string;
    channelId: string;
    statusSet: boolean;
}

export type AuthLoginStatus = "idle" | "waiting_for_login" | "logged_in" | "error";

export interface AuthSessionRecord {
    id: number;
    provider: string;
    status: AuthLoginStatus;
    email: string | null;
    visitorData: string | null;
    cookieHash: string | null;
    lastRefresh: number | null;
    error: string | null;
}

export type PlaybackStatus = "idle" | "buffering" | "playing" | "paused" | "recovering" | "stopped";
