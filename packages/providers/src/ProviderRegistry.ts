import type { MetadataCacheClient } from "@rawon/cache";
import {
    assertSafePublicUrl,
    type Logger,
    ProviderError,
    type SearchProviderMode,
    type SearchResult,
    type StreamDescriptor,
    type Track,
} from "@rawon/shared";
import { DirectHttpProvider } from "./DirectHttpProvider.js";
import type { ProviderHealth } from "./interfaces.js";
import { LyricsService } from "./LyricsService.js";
import { classifyQuery } from "./QueryClassifier.js";
import { SoundCloudProvider } from "./SoundCloudProvider.js";
import { SpotifyProvider } from "./SpotifyProvider.js";
import { YouTubeProvider } from "./YouTubeProvider.js";
import type { YtDlpClient } from "./YtDlpClient.js";

export interface ProviderRegistryOptions {
    ytdlp: YtDlpClient;
    spotifyClientId?: string;
    spotifyClientSecret?: string;
    spotifyMarket?: string;
    stegripeApiUrl?: string;
    stegripeApiLyricsToken?: string;
    metadataCache?: MetadataCacheClient;
    logger?: Logger;
}

export class ProviderRegistry {
    public readonly youtube: YouTubeProvider;
    public readonly soundcloud: SoundCloudProvider;
    public readonly spotify: SpotifyProvider;
    public readonly directHttp: DirectHttpProvider;
    public readonly lyrics: LyricsService;
    public readonly ytdlp: YtDlpClient;

    private readonly metadataCache?: MetadataCacheClient;
    private readonly logger?: Logger;
    private readonly failureCounts = new Map<string, number>();

    public constructor(options: ProviderRegistryOptions) {
        this.ytdlp = options.ytdlp;
        this.metadataCache = options.metadataCache;
        this.logger = options.logger;

        this.youtube = new YouTubeProvider(options.ytdlp);
        this.soundcloud = new SoundCloudProvider(options.ytdlp);
        this.directHttp = new DirectHttpProvider();
        this.spotify = new SpotifyProvider({
            clientId: options.spotifyClientId ?? "",
            clientSecret: options.spotifyClientSecret ?? "",
            market: options.spotifyMarket ?? "US",
            resolvePlayableTrack: async (query) => {
                const res = await this.search(query, "youtube", 1, "dsp").catch(() => null);
                return res?.items[0] ?? null;
            },
        });
        this.lyrics = new LyricsService(
            options.stegripeApiUrl ?? "https://api.stegripe.org",
            options.stegripeApiLyricsToken ?? "",
            options.metadataCache,
        );
    }

    public async search(
        query: string,
        source: "youtube" | "soundcloud" = "youtube",
        limit = 10,
        mode: SearchProviderMode = "dsp",
    ): Promise<SearchResult> {
        const trimmed = query.trim();
        if (!trimmed) {
            throw new ProviderError("Search query cannot be empty", "validation", false);
        }

        const classified = classifyQuery(trimmed);
        if (classified.isUrl) {
            return this.resolveUrl(trimmed);
        }

        const cacheKey = `search:${source}:${mode}:${limit}:${trimmed.toLowerCase()}`;
        const cached = await this.metadataCache?.getJson<SearchResult>(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const result =
                source === "soundcloud"
                    ? await this.soundcloud.search(trimmed, limit)
                    : await this.youtube.search(trimmed, limit, mode);

            this.failureCounts.set(source, 0);
            if (result.items.length > 0) {
                await this.metadataCache?.setJson(cacheKey, result, 900);
            }
            return result;
        } catch (err) {
            this.recordFailure(source);
            if (source === "youtube") {
                this.logger?.warn(
                    { err, query: trimmed },
                    "YouTube search failed; falling back to SoundCloud",
                );
                return this.soundcloud.search(trimmed, limit);
            }
            throw err;
        }
    }

    public async resolveUrl(rawUrl: string): Promise<SearchResult> {
        const safeUrl = (await assertSafePublicUrl(rawUrl)).toString();
        const classified = classifyQuery(safeUrl);

        const cacheKey = `resolve:${classified.sourceType}:${safeUrl}`;
        const cached = await this.metadataCache?.getJson<SearchResult>(cacheKey);
        if (cached) {
            return cached;
        }

        let result: SearchResult;

        if (classified.sourceType === "spotify") {
            result = await this.spotify.resolveUrl(safeUrl);
        } else if (
            classified.sourceType === "youtube" ||
            classified.sourceType === "youtubemusic"
        ) {
            result = await this.youtube.resolveUrl(safeUrl, classified.kind);
        } else if (classified.sourceType === "soundcloud") {
            result = await this.soundcloud.resolveUrl(safeUrl, classified.kind);
        } else if (classified.sourceType === "direct") {
            result = await this.directHttp.resolveDirectUrl(safeUrl);
        } else {
            // Try generic extractor first (e.g. Bandcamp/Mixcloud/generic supported pages via yt-dlp), then Direct HTTP
            try {
                result = await this.youtube.resolveUrl(safeUrl, "unknown");
                if (result.items.length === 0) {
                    result = await this.directHttp.resolveDirectUrl(safeUrl);
                }
            } catch {
                result = await this.directHttp.resolveDirectUrl(safeUrl);
            }
        }

        if (result.items.length > 0) {
            await this.metadataCache?.setJson(cacheKey, result, 600);
        }
        return result;
    }

    public async hydrateTrack(track: Track): Promise<Track> {
        const key = `hydrate:${track.provider}:${track.id || track.url}`;
        const cached = await this.metadataCache?.getJson<Track>(key);
        if (cached && cached.duration > 0 && cached.thumbnail) {
            return cached;
        }

        let hydrated = track;
        if (track.provider === "soundcloud") {
            hydrated = await this.soundcloud.hydrateTrack(track).catch(() => track);
        } else if (
            track.provider === "youtube" ||
            track.provider === "youtubemusic" ||
            (track.provider === "spotify" && track.playableUrl)
        ) {
            hydrated = await this.youtube.hydrateTrack(track).catch(() => track);
        }

        await this.metadataCache?.setJson(key, hydrated, 3600);
        return hydrated;
    }

    public async getStreamDescriptor(
        track: Track,
        options: { allowFallbackProvider?: boolean; signal?: AbortSignal } = {},
    ): Promise<StreamDescriptor> {
        const providerKey = track.provider;

        try {
            let desc: StreamDescriptor;
            if (track.provider === "direct" || track.provider === "attachment") {
                desc = await this.directHttp.getStreamDescriptor(track, options.signal);
            } else if (track.provider === "soundcloud") {
                desc = await this.soundcloud.getStreamDescriptor(track, options.signal);
            } else {
                desc = await this.youtube.getStreamDescriptor(track, options.signal);
            }
            this.failureCounts.set(providerKey, 0);
            return desc;
        } catch (primaryErr) {
            this.recordFailure(providerKey);

            // Don't silently swap tracks when caller blocked fallback or it's an auth/validation error
            if (
                options.allowFallbackProvider === false ||
                (primaryErr instanceof ProviderError &&
                    (primaryErr.category === "age_restricted" ||
                        primaryErr.category === "bot_detection"))
            ) {
                throw primaryErr;
            }

            // Fallback: try re-searching by title/artist on alternative provider
            const fallbackQuery = [track.author, track.title].filter(Boolean).join(" ").trim();
            if (!fallbackQuery) {
                throw primaryErr;
            }

            const targetAlt = track.provider === "soundcloud" ? "youtube" : "soundcloud";
            this.logger?.warn(
                { err: primaryErr, track: track.title, targetAlt },
                "Primary stream resolution failed; trying fallback provider",
            );

            const altSearch = await this.search(fallbackQuery, targetAlt, 5, "direct").catch(
                () => null,
            );
            // When falling back to SoundCloud, skip 30-second Go+ preview snippets if a full-length track exists
            const candidate =
                (targetAlt === "soundcloud"
                    ? altSearch?.items.find((item) => item.duration === 0 || item.duration > 35)
                    : undefined) ?? altSearch?.items[0];
            if (!candidate) {
                throw primaryErr;
            }

            return targetAlt === "soundcloud"
                ? this.soundcloud.getStreamDescriptor(candidate, options.signal)
                : this.youtube.getStreamDescriptor(candidate, options.signal);
        }
    }

    public async findRelatedTracks(
        seedTrack: Track,
        excludeIds: ReadonlySet<string>,
    ): Promise<Track[]> {
        return this.youtube.findRelated(seedTrack, excludeIds);
    }

    public async getHealthReport(): Promise<ProviderHealth[]> {
        const [yt, sc, lyricsHealth] = await Promise.all([
            this.youtube.healthCheck(),
            this.soundcloud.healthCheck(),
            this.lyrics.getHealth(),
        ]);

        const spotifyHealth: ProviderHealth = {
            name: "spotify",
            healthy: this.spotify.isConfigured(),
            consecutiveFailures: 0,
            lastError: this.spotify.isConfigured() ? undefined : "Spotify credentials not set",
            lastCheckedAt: Date.now(),
        };

        return [
            {
                ...yt,
                consecutiveFailures: this.failureCounts.get("youtube") ?? yt.consecutiveFailures,
            },
            {
                ...sc,
                consecutiveFailures: this.failureCounts.get("soundcloud") ?? sc.consecutiveFailures,
            },
            spotifyHealth,
            ...lyricsHealth,
        ];
    }

    private recordFailure(provider: string): void {
        this.failureCounts.set(provider, (this.failureCounts.get(provider) ?? 0) + 1);
    }
}
