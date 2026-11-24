import { existsSync, statSync } from "node:fs";
import {
    type PlaylistMetadata,
    ProviderError,
    type SearchProviderMode,
    type SearchResult,
    type StreamDescriptor,
    type Track,
} from "@rawon/shared";
import type { ClassifiedQuery, MediaProvider, ProviderHealth, QueryKind } from "./interfaces.js";
import { classifyQuery, extractYouTubeVideoId, isYouTubeMusicUrl } from "./QueryClassifier.js";
import { rankTrackCandidates } from "./trackMatcher.js";
import {
    extractBestAudioFormat,
    isHlsFormat,
    ResolvedEntryCache,
    selectPlayableFormatFromEntry,
    type YtDlpClient,
    type YtDlpEntry,
    type YtDlpFormatEntry,
} from "./YtDlpClient.js";
import {
    fetchYouTubeVideosByIdsDataApi,
    resolveYouTubePlaylistDataApi,
    searchYouTubeDataApi,
} from "./youtubeDataApi.js";
import {
    getOrFetchYouTubeVisitorData,
    loadYouTubeCookieHeader,
    resolveYouTubeInnerTubePlayerWithStatus,
} from "./youtubeInnerTubePlayer.js";
import { searchYouTubeMusicInnerTube, upgradeThumbnailUrl } from "./youtubeMusic.js";
import { resolveYouTubeCipheredStream, type YouTubeOAuthManager } from "./youtubeOAuth.js";

interface YtDlpFallbackCandidate {
    extractorArgs: string;
    skipCookies: boolean;
}

// Keep fallback concurrency bounded (<= 3 per wave) to prevent yt-dlp/EJS memory spikes in Docker
const YOUTUBE_FALLBACK_WAVES: ReadonlyArray<ReadonlyArray<YtDlpFallbackCandidate>> = [
    [
        { extractorArgs: "youtube:player_client=android", skipCookies: true },
        { extractorArgs: "youtube:player_client=mweb", skipCookies: true },
        { extractorArgs: "youtube:player_client=tv_simply", skipCookies: true },
    ],
    [
        { extractorArgs: "youtube:player_client=android_vr", skipCookies: true },
        { extractorArgs: "youtube:player_client=web_embedded", skipCookies: false },
        { extractorArgs: "youtube:player_client=visionos", skipCookies: true },
    ],
];

const YOUTUBE_COOKIE_FALLBACK_WAVES: ReadonlyArray<ReadonlyArray<YtDlpFallbackCandidate>> = [
    [
        { extractorArgs: "youtube:player_client=mweb", skipCookies: false },
        { extractorArgs: "youtube:player_client=web_creator", skipCookies: false },
        { extractorArgs: "youtube:player_client=tv_simply", skipCookies: false },
    ],
    [
        { extractorArgs: "youtube:player_client=android", skipCookies: true },
        { extractorArgs: "youtube:player_client=mweb", skipCookies: true },
        { extractorArgs: "youtube:player_client=android_vr", skipCookies: true },
    ],
    [
        { extractorArgs: "youtube:player_client=tv_simply", skipCookies: true },
        { extractorArgs: "youtube:player_client=web_embedded", skipCookies: true },
        { extractorArgs: "youtube:player_client=visionos", skipCookies: true },
    ],
];

function positiveDuration(val: unknown): number {
    return typeof val === "number" && Number.isFinite(val) && val > 0 ? Math.floor(val) : 0;
}

function pickThumbnail(entry: YtDlpEntry): string {
    const candidates = entry.thumbnails ?? [];
    const last = candidates[candidates.length - 1]?.url;
    return upgradeThumbnailUrl(entry.thumbnail ?? last ?? "");
}

function mapEntryToTrack(
    entry: YtDlpEntry,
    forceProvider?: "youtube" | "youtubemusic",
): Track | null {
    const rawId = entry.id?.trim() ?? "";
    const rawUrl = (entry.webpage_url ?? entry.original_url ?? entry.url ?? "").trim();
    const title = (entry.title ?? entry.fulltitle ?? "").trim();
    if ((!rawId && !rawUrl) || !title) {
        return null;
    }
    const videoId = extractYouTubeVideoId(rawId) ?? extractYouTubeVideoId(rawUrl);
    const isYtm = forceProvider === "youtubemusic" || isYouTubeMusicUrl(rawUrl);
    const provider = isYtm ? "youtubemusic" : "youtube";

    const url =
        isYtm && videoId
            ? `https://music.youtube.com/watch?v=${videoId}`
            : rawUrl || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : "");
    if (!url) {
        return null;
    }

    const playableUrl = isYtm && videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined;
    return {
        id: videoId ?? rawId,
        title,
        url,
        playableUrl,
        duration: positiveDuration(entry.duration),
        thumbnail:
            pickThumbnail(entry) ||
            (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : ""),
        author:
            (entry.artist ?? entry.uploader ?? entry.channel ?? entry.creator)?.trim() || undefined,
        isLive: entry.is_live === true || entry.live_status === "is_live",
        provider,
    };
}

export interface YouTubeProviderOptions {
    youtubeApiKey?: string | null;
    oauthManager?: YouTubeOAuthManager | null;
}

export class YouTubeProvider implements MediaProvider {
    public readonly name = "youtube" as const;
    private readonly entryCache = new ResolvedEntryCache();
    private readonly inflightPlayerLookups = new Map<
        string,
        Promise<{ entry: YtDlpEntry | null; botDetected: boolean }>
    >();
    private readonly forceProbeVideoIds = new Set<string>();
    private readonly youtubeApiKey: string | null;
    private readonly oauthManager: YouTubeOAuthManager | null;
    private botBlockedUntil = 0;
    private cookieBotBlockedUntil = 0;
    private cookieBlockedMtimeMs = -1;

    public constructor(
        private readonly ytdlp: YtDlpClient,
        options?: YouTubeProviderOptions,
    ) {
        this.youtubeApiKey = options?.youtubeApiKey?.trim() || null;
        this.oauthManager = options?.oauthManager ?? null;
    }

    public isBotBlocked(): boolean {
        return this.botBlockedUntil > Date.now();
    }

    public invalidateTrackCache(track: Track): void {
        const target = track.playableUrl || track.url;
        const videoId = extractYouTubeVideoId(track.id) ?? extractYouTubeVideoId(target);
        this.entryCache.delete(
            [
                target,
                track.url,
                track.id,
                videoId ?? "",
                videoId ? `https://www.youtube.com/watch?v=${videoId}` : "",
                videoId ? `https://music.youtube.com/watch?v=${videoId}` : "",
            ].filter(Boolean),
        );
        if (videoId) {
            this.forceProbeVideoIds.add(videoId);
        }
    }

    private getCookieState(): {
        hasCookies: boolean;
        mtimeMs: number;
        isCookieBlocked: boolean;
    } {
        const p = this.ytdlp.getCookiesPath?.();
        if (!p || !existsSync(p)) {
            return { hasCookies: false, mtimeMs: -1, isCookieBlocked: false };
        }
        let mtimeMs = 0;
        try {
            mtimeMs = statSync(p).mtimeMs;
        } catch {
            return { hasCookies: false, mtimeMs: -1, isCookieBlocked: false };
        }
        const isCookieBlocked =
            this.cookieBlockedMtimeMs === mtimeMs && this.cookieBotBlockedUntil > Date.now();
        return { hasCookies: true, mtimeMs, isCookieBlocked };
    }

    private getInnerTubeOptions(): { cookiesPath?: string | null; visitorData?: string | null } {
        return {
            cookiesPath: this.ytdlp.getCookiesPath?.() ?? null,
            visitorData: this.ytdlp.getVisitorData?.() ?? null,
        };
    }

    private warmVisitorData(): void {
        void getOrFetchYouTubeVisitorData(undefined, this.getInnerTubeOptions()).catch(() => null);
    }

    private async resolveFastPlayerEntryWithStatus(
        videoId: string,
        signal?: AbortSignal,
    ): Promise<{ entry: YtDlpEntry | null; botDetected: boolean }> {
        const existing = this.inflightPlayerLookups.get(videoId);
        if (existing) {
            return existing;
        }
        const promise = (async () => {
            const innerTubeOpts = this.getInnerTubeOptions();
            const cookieState = this.getCookieState();
            const cookieHeader =
                cookieState.hasCookies && !cookieState.isCookieBlocked
                    ? loadYouTubeCookieHeader(innerTubeOpts.cookiesPath)
                    : null;

            // 1. If VPS OAuth2 is linked, resolve via authenticated TVHTML5 + JS cipher first (~250ms)
            if (this.oauthManager?.hasRefreshToken() && !signal?.aborted) {
                const oauthRes = await resolveYouTubeCipheredStream(videoId, {
                    oauthManager: this.oauthManager,
                    signal,
                });
                if (oauthRes.entry) {
                    return oauthRes;
                }
            }

            // 2. Direct mobile/VISIONOS/ANDROID_VR InnerTube (~180ms)
            const innerRes = await resolveYouTubeInnerTubePlayerWithStatus(
                videoId,
                signal,
                innerTubeOpts,
            );
            if (innerRes.entry) {
                return innerRes;
            }

            // 3. Ciphered YTMUSIC / cookie-WEB fallback via cached Node.js player.js (~350ms, zero yt-dlp spawn)
            const cipherRes = await resolveYouTubeCipheredStream(videoId, {
                cookieHeader,
                signal,
            });
            if (cipherRes.entry) {
                return cipherRes;
            }

            return {
                entry: null,
                botDetected: innerRes.botDetected || cipherRes.botDetected,
            };
        })()
            .then((res) => {
                if (res.entry) {
                    this.entryCache.store(
                        [
                            videoId,
                            `https://www.youtube.com/watch?v=${videoId}`,
                            `https://music.youtube.com/watch?v=${videoId}`,
                        ],
                        res.entry,
                    );
                }
                return res;
            })
            .finally(() => {
                this.inflightPlayerLookups.delete(videoId);
            });
        this.inflightPlayerLookups.set(videoId, promise);
        return promise;
    }

    private async resolveFastPlayerEntry(
        videoId: string,
        signal?: AbortSignal,
    ): Promise<YtDlpEntry | null> {
        const res = await this.resolveFastPlayerEntryWithStatus(videoId, signal);
        return res.entry;
    }

    public warmTrackPlayerEntry(track: Track | undefined): void {
        if (!track) return;
        const sourceUrl = track.playableUrl || track.url;
        const videoId = extractYouTubeVideoId(track.id) ?? extractYouTubeVideoId(sourceUrl);
        if (!videoId) return;
        if (this.entryCache.get([sourceUrl, track.url, videoId])) return;
        void this.resolveFastPlayerEntry(videoId).catch(() => null);
    }

    public supportsUrl(url: string): boolean {
        const c = this.classifyUrl(url);
        return c !== null;
    }

    public classifyUrl(url: string): ClassifiedQuery | null {
        const classified = classifyQuery(url);
        if (classified.sourceType === "youtube" || classified.sourceType === "youtubemusic") {
            return classified;
        }
        return null;
    }

    public async search(
        query: string,
        limit = 10,
        mode: SearchProviderMode = "dsp",
    ): Promise<SearchResult> {
        // Warm visitorData token concurrently with search so stream resolution is 1-RTT
        this.warmVisitorData();
        const candidatePool = Math.max(limit, 8);
        if (mode === "dsp") {
            try {
                const items = await searchYouTubeMusicInnerTube(query, candidatePool);
                if (items.length > 0) {
                    const ranked = rankTrackCandidates(items, { query });
                    const bestScore = ranked[0]?.score ?? Number.NEGATIVE_INFINITY;
                    // If YTM top candidate is an accurate match, return immediately without spawning yt-dlp
                    if (bestScore >= 25) {
                        const topItems = ranked.slice(0, limit).map((r) => r.track);
                        this.warmTrackPlayerEntry(topItems[0]);
                        return {
                            type: "selection",
                            items: topItems,
                        };
                    }
                    // Otherwise merge with direct YouTube search so obscure/unlisted originals aren't missed
                    const directItems = await this.searchDirectYouTube(query, candidatePool).catch(
                        () => [] as Track[],
                    );
                    const seenIds = new Set(items.map((t) => t.id));
                    const combined = [...items, ...directItems.filter((t) => !seenIds.has(t.id))];
                    const mergedItems = rankTrackCandidates(combined, { query })
                        .slice(0, limit)
                        .map((r) => r.track);
                    this.warmTrackPlayerEntry(mergedItems[0]);
                    return {
                        type: "selection",
                        items: mergedItems,
                    };
                }
            } catch {
                // Fall back to ytsearch via yt-dlp cleanly
            }
        }

        const items = await this.searchDirectYouTube(query, candidatePool);
        const directRanked = rankTrackCandidates(items, { query })
            .slice(0, limit)
            .map((r) => r.track);
        this.warmTrackPlayerEntry(directRanked[0]);
        return {
            type: "selection",
            items: directRanked,
        };
    }

    private async searchDirectYouTube(query: string, fetchLimit: number): Promise<Track[]> {
        if (this.youtubeApiKey) {
            const apiItems = await searchYouTubeDataApi(
                query,
                this.youtubeApiKey,
                fetchLimit,
                "youtube",
            ).catch(() => null);
            if (apiItems && apiItems.length > 0) {
                return apiItems;
            }
        }

        const dump = await this.ytdlp.dumpJson(`ytsearch${fetchLimit}:${query}`, {
            flatPlaylist: true,
            playlistEnd: fetchLimit,
        });
        const items: Track[] = [];
        for (const entry of dump.entries ?? []) {
            if (!entry) continue;
            const mapped = mapEntryToTrack(entry);
            if (mapped) items.push(mapped);
        }
        return items;
    }

    public async resolveUrl(url: string, kind: QueryKind): Promise<SearchResult> {
        const isCollection = kind === "playlist" || kind === "artist";
        const isYtm = isYouTubeMusicUrl(url);

        if (isCollection && this.youtubeApiKey) {
            try {
                const playlistId = new URL(url).searchParams.get("list")?.trim() ?? "";
                if (playlistId) {
                    const apiPlaylist = await resolveYouTubePlaylistDataApi(
                        playlistId,
                        url,
                        this.youtubeApiKey,
                    );
                    if (apiPlaylist && apiPlaylist.items.length > 0) {
                        this.warmTrackPlayerEntry(apiPlaylist.items[0]);
                        return apiPlaylist;
                    }
                }
            } catch {
                // Fall back to yt-dlp playlist extraction
            }
        }

        if (!isCollection) {
            const singleVideoId = extractYouTubeVideoId(url);
            if (singleVideoId) {
                if (this.youtubeApiKey) {
                    const apiTracks = await fetchYouTubeVideosByIdsDataApi(
                        [singleVideoId],
                        this.youtubeApiKey,
                        isYtm ? "youtubemusic" : "youtube",
                    ).catch(() => []);
                    if (apiTracks[0]) {
                        this.warmTrackPlayerEntry(apiTracks[0]);
                        return { type: "results", items: [apiTracks[0]] };
                    }
                }

                const fastDump = await this.resolveFastPlayerEntry(singleVideoId);
                if (fastDump) {
                    const fastSingle = mapEntryToTrack(
                        fastDump,
                        isYtm ? "youtubemusic" : undefined,
                    );
                    if (fastSingle) {
                        this.entryCache.store(
                            [url, fastSingle.url, fastSingle.playableUrl, fastSingle.id],
                            fastDump,
                        );
                        return {
                            type: "results",
                            items: [fastSingle],
                        };
                    }
                }
            }
        }

        const targetDumpUrl =
            isCollection && isYtm
                ? url.replace(/^https?:\/\/music\.youtube\.com\//i, "https://www.youtube.com/")
                : url;

        const dump = await this.ytdlp.dumpJson(targetDumpUrl, {
            flatPlaylist: isCollection,
            yesPlaylist: isCollection,
            noPlaylist: !isCollection,
        });

        if (Array.isArray(dump.entries) || dump._type === "playlist") {
            const items: Track[] = [];
            let skippedCount = 0;
            for (const entry of dump.entries ?? []) {
                if (!entry) {
                    skippedCount += 1;
                    continue;
                }
                const mapped = mapEntryToTrack(entry, isYtm ? "youtubemusic" : undefined);
                if (!mapped) {
                    skippedCount += 1;
                    continue;
                }
                items.push(mapped);
            }
            this.warmTrackPlayerEntry(items[0]);
            const playlist: PlaylistMetadata = {
                title: (dump.playlist_title ?? dump.title ?? dump.playlist ?? "Playlist").trim(),
                url: (dump.webpage_url ?? dump.original_url ?? url).trim(),
                thumbnail: pickThumbnail(dump) || items[0]?.thumbnail || "",
                author: (dump.uploader ?? dump.channel ?? dump.artist)?.trim() || undefined,
                skippedCount: skippedCount > 0 ? skippedCount : undefined,
                skippedReason: skippedCount > 0 ? "unavailable" : undefined,
            };
            return { type: "results", items, playlist };
        }

        const single = mapEntryToTrack(dump, isYtm ? "youtubemusic" : undefined);
        if (single) {
            this.entryCache.store([url, single.url, single.playableUrl, single.id], dump);
        }
        return {
            type: "results",
            items: single ? [single] : [],
        };
    }

    public async hydrateTrack(track: Track): Promise<Track> {
        if (track.duration > 0 && track.thumbnail && track.author && track.title) {
            return track;
        }
        const sourceUrl = track.playableUrl || track.url;
        const videoId = extractYouTubeVideoId(track.id) ?? extractYouTubeVideoId(sourceUrl);
        if (videoId && this.youtubeApiKey) {
            const apiTracks = await fetchYouTubeVideosByIdsDataApi(
                [videoId],
                this.youtubeApiKey,
                track.provider === "youtubemusic" ? "youtubemusic" : "youtube",
            ).catch(() => []);
            if (apiTracks[0]) {
                return {
                    ...track,
                    ...apiTracks[0],
                    thumbnail: apiTracks[0].thumbnail || track.thumbnail,
                };
            }
        }
        const dump =
            (videoId ? await this.resolveFastPlayerEntry(videoId) : null) ??
            (await this.ytdlp.dumpJson(sourceUrl, { noPlaylist: true }));
        this.entryCache.store([sourceUrl, track.url, track.id], dump);
        const hydrated = mapEntryToTrack(
            dump,
            track.provider === "youtubemusic" ? "youtubemusic" : undefined,
        );
        if (!hydrated) {
            return track;
        }
        return {
            ...track,
            id: hydrated.id || track.id,
            title: hydrated.title || track.title,
            duration: hydrated.duration > 0 ? hydrated.duration : track.duration,
            thumbnail: track.thumbnail.includes("googleusercontent.com")
                ? track.thumbnail
                : hydrated.thumbnail || track.thumbnail,
            author: hydrated.author ?? track.author,
            isLive: hydrated.isLive ?? track.isLive,
            playableUrl: hydrated.playableUrl ?? track.playableUrl,
        };
    }

    public async getStreamDescriptor(
        track: Track,
        signal?: AbortSignal,
    ): Promise<StreamDescriptor> {
        const target = track.playableUrl || track.url;
        let entry: YtDlpEntry | null = null;
        let fmt: YtDlpFormatEntry | null = null;
        let primaryErr: unknown = null;

        const cacheKeys = [target, track.url, track.id];
        const videoId = extractYouTubeVideoId(track.id) ?? extractYouTubeVideoId(target);
        const mustProbe = Boolean(videoId && this.forceProbeVideoIds.has(videoId));

        const cachedEntry = this.entryCache.get(cacheKeys);
        if (cachedEntry) {
            entry = cachedEntry;
            const fastCachedFmt =
                !mustProbe && cachedEntry.extractor === "youtube:innertube:visionos"
                    ? extractBestAudioFormat(cachedEntry)
                    : null;
            fmt =
                fastCachedFmt && !isHlsFormat(fastCachedFmt)
                    ? fastCachedFmt
                    : await selectPlayableFormatFromEntry(cachedEntry, signal);
            if (!fmt?.url) {
                this.entryCache.delete(cacheKeys);
                entry = null;
            }
        }

        // Fast Path: ~150-350ms direct InnerTube / OAuth2 / ciphered JS resolution (zero yt-dlp process spawn)
        let fastBotDetected = false;
        if (!fmt?.url && videoId && !signal?.aborted) {
            const fastRes = await this.resolveFastPlayerEntryWithStatus(videoId, signal);
            fastBotDetected = fastRes.botDetected;
            const innerTubeEntry = fastRes.entry;
            if (innerTubeEntry) {
                const fastInnerTubeFmt =
                    !mustProbe && innerTubeEntry.extractor === "youtube:innertube:visionos"
                        ? extractBestAudioFormat(innerTubeEntry)
                        : null;
                const innerTubeFmt =
                    fastInnerTubeFmt && !isHlsFormat(fastInnerTubeFmt)
                        ? fastInnerTubeFmt
                        : await selectPlayableFormatFromEntry(innerTubeEntry, signal);
                if (innerTubeFmt?.url) {
                    entry = innerTubeEntry;
                    fmt = innerTubeFmt;
                    this.botBlockedUntil = 0;
                    this.cookieBotBlockedUntil = 0;
                    if (mustProbe) {
                        this.forceProbeVideoIds.delete(videoId);
                    }
                    this.entryCache.store(cacheKeys, innerTubeEntry);
                }
            }
        }

        const cookieState = this.getCookieState();
        const hasCookies = cookieState.hasCookies && !cookieState.isCookieBlocked;
        const hasPotProvider = Boolean(this.ytdlp.getPotProviderUrl?.());
        const primaryExtractorArgs = hasCookies
            ? "youtube:player_client=mweb,web_creator,web,tv_simply"
            : hasPotProvider
              ? "youtube:player_client=mweb,tv_simply,android_vr"
              : undefined;

        if (!fmt?.url && !signal?.aborted) {
            if ((this.botBlockedUntil > Date.now() && !hasCookies) || cookieState.isCookieBlocked) {
                throw new ProviderError(
                    "YouTube requested bot-verification cookies",
                    "bot_detection",
                    false,
                );
            }

            // If InnerTube already confirmed this VPS IP is bot-blocked and neither active cookies
            // nor a reachable PO-Token server exist, skip 30s of dead yt-dlp spawns immediately
            if (fastBotDetected && !hasCookies) {
                const potReachable = hasPotProvider
                    ? ((await this.ytdlp.isPotProviderReachable?.(signal)) ?? true)
                    : false;
                if (!potReachable) {
                    this.botBlockedUntil = Date.now() + 180_000;
                    throw new ProviderError(
                        "YouTube requested bot-verification cookies",
                        "bot_detection",
                        false,
                    );
                }
            }

            try {
                entry = await this.ytdlp.dumpJson(target, {
                    noPlaylist: true,
                    format: "bestaudio[acodec=opus]/bestaudio/best",
                    ...(primaryExtractorArgs ? { extractorArgs: primaryExtractorArgs } : {}),
                    skipCookies: cookieState.isCookieBlocked,
                    timeoutMs: 12_000,
                    signal,
                });
                fmt = await selectPlayableFormatFromEntry(entry, signal);
                if (fmt?.url && entry) {
                    this.botBlockedUntil = 0;
                    this.cookieBotBlockedUntil = 0;
                    this.entryCache.store(cacheKeys, entry);
                }
            } catch (err) {
                primaryErr = err;
                if (err instanceof ProviderError && err.category === "age_restricted") {
                    throw err;
                }
            }
        }

        let sawBotDetection =
            fastBotDetected ||
            (primaryErr instanceof ProviderError && primaryErr.category === "bot_detection");

        // Dual-stack VPS hosts often trigger bot-checks on IPv6 while IPv4 passes; skip if already forced to IPv4
        if (!fmt?.url && sawBotDetection && !this.ytdlp.isForceIpv4?.() && !signal?.aborted) {
            try {
                const ipv4Entry = await this.ytdlp.dumpJson(target, {
                    noPlaylist: true,
                    format: "bestaudio[acodec=opus]/bestaudio/best",
                    ...(primaryExtractorArgs ? { extractorArgs: primaryExtractorArgs } : {}),
                    skipCookies: cookieState.isCookieBlocked,
                    forceIpv4: true,
                    timeoutMs: 10_000,
                    signal,
                });
                const ipv4Fmt = await selectPlayableFormatFromEntry(ipv4Entry, signal);
                if (ipv4Fmt?.url) {
                    entry = ipv4Entry;
                    fmt = ipv4Fmt;
                    this.botBlockedUntil = 0;
                    this.cookieBotBlockedUntil = 0;
                    this.entryCache.store(cacheKeys, ipv4Entry);
                }
            } catch (ipv4Err) {
                if (ipv4Err instanceof ProviderError && ipv4Err.category === "age_restricted") {
                    throw ipv4Err;
                }
            }
        }

        // Fallback across bounded waves (max 3 concurrent yt-dlp processes per wave) to protect container memory
        if (!fmt?.url && !signal?.aborted) {
            const waves = hasCookies ? YOUTUBE_COOKIE_FALLBACK_WAVES : YOUTUBE_FALLBACK_WAVES;
            for (const wave of waves) {
                if (signal?.aborted || fmt?.url) break;
                const raceController = new AbortController();
                const onParentAbort = () => raceController.abort();
                signal?.addEventListener("abort", onParentAbort, { once: true });

                try {
                    const winner = await Promise.any(
                        wave.map(async ({ extractorArgs, skipCookies }) => {
                            const fallbackEntry = await this.ytdlp.dumpJson(target, {
                                noPlaylist: true,
                                format: "bestaudio/best",
                                extractorArgs,
                                forceIpv4: sawBotDetection,
                                skipCookies: skipCookies || cookieState.isCookieBlocked,
                                timeoutMs: 10_000,
                                signal: raceController.signal,
                            });
                            const fallbackFmt = await selectPlayableFormatFromEntry(
                                fallbackEntry,
                                raceController.signal,
                            );
                            if (!fallbackFmt?.url) {
                                throw new ProviderError(
                                    `No streamable format from ${extractorArgs}`,
                                    "unavailable",
                                    true,
                                );
                            }
                            return { fallbackEntry, fallbackFmt };
                        }),
                    );
                    raceController.abort();
                    entry = winner.fallbackEntry;
                    fmt = winner.fallbackFmt;
                    this.botBlockedUntil = 0;
                    this.cookieBotBlockedUntil = 0;
                    this.entryCache.store(cacheKeys, winner.fallbackEntry);
                    break;
                } catch (aggErr) {
                    const errors =
                        aggErr instanceof AggregateError ? (aggErr.errors as unknown[]) : [aggErr];
                    for (const fallbackErr of errors) {
                        if (fallbackErr instanceof ProviderError) {
                            if (fallbackErr.category === "age_restricted") {
                                throw fallbackErr;
                            }
                            if (fallbackErr.category === "bot_detection") {
                                sawBotDetection = true;
                                if (!primaryErr) {
                                    primaryErr = fallbackErr;
                                }
                            } else if (!primaryErr) {
                                primaryErr = fallbackErr;
                            }
                        }
                    }
                } finally {
                    signal?.removeEventListener("abort", onParentAbort);
                }
            }

            if (!fmt?.url && sawBotDetection) {
                if (hasCookies) {
                    this.cookieBlockedMtimeMs = cookieState.mtimeMs;
                    this.cookieBotBlockedUntil = Date.now() + 180_000;
                } else {
                    this.botBlockedUntil = Date.now() + 180_000;
                }
                if (
                    !(
                        primaryErr instanceof ProviderError &&
                        primaryErr.category === "bot_detection"
                    )
                ) {
                    primaryErr = new ProviderError(
                        "YouTube requested bot-verification cookies",
                        "bot_detection",
                        false,
                        primaryErr,
                    );
                }
            }
        }

        if (!fmt?.url || !entry) {
            if (primaryErr instanceof ProviderError) {
                throw primaryErr;
            }
            throw new ProviderError(
                `No streamable audio format found for ${target}`,
                "network",
                true,
                primaryErr,
            );
        }

        const isLive = entry.is_live === true || entry.live_status === "is_live";
        const canonicalKey = videoId ? `youtube:${videoId}` : `youtube:${target}`;

        const codec = fmt.acodec?.toLowerCase();
        const container = fmt.ext?.toLowerCase();
        const sampleRate = fmt.asr ?? (codec?.includes("opus") ? 48_000 : undefined);
        const channels = fmt.audio_channels ?? (codec?.includes("opus") ? 2 : undefined);
        const passthrough =
            !isLive &&
            !isHlsFormat(fmt) &&
            Boolean(codec?.includes("opus")) &&
            (container === "webm" || container === "ogg" || container === "opus") &&
            sampleRate === 48_000 &&
            channels === 2;
        const estimatedBitrateBps = fmt.abr
            ? Math.round(fmt.abr * 1000)
            : fmt.format_id === "234"
              ? 132_000
              : undefined;

        return {
            sourceType: "url",
            url: fmt.url,
            canonicalKey,
            container,
            codec,
            sampleRate,
            channels,
            bitrateBps: estimatedBitrateBps,
            durationSeconds: positiveDuration(entry.duration) || track.duration,
            isLive,
            seekable: !isLive,
            directPassthroughEligible: passthrough,
            headers: fmt.http_headers ?? entry.http_headers,
            resolvedAt: Date.now(),
            expiresAt: Date.now() + 5 * 3_600_000,
        };
    }

    public async findRelated(seedTrack: Track, excludeIds: ReadonlySet<string>): Promise<Track[]> {
        const videoId = extractYouTubeVideoId(seedTrack.id) ?? extractYouTubeVideoId(seedTrack.url);
        if (videoId) {
            try {
                const mixUrl = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
                const dump = await this.ytdlp.dumpJson(mixUrl, {
                    flatPlaylist: true,
                    playlistEnd: 15,
                });
                const candidates: Track[] = [];
                for (const entry of dump.entries ?? []) {
                    if (!entry) continue;
                    const mapped = mapEntryToTrack(entry);
                    if (!mapped) continue;
                    if (mapped.id === videoId || excludeIds.has(mapped.id)) continue;
                    candidates.push(mapped);
                }
                if (candidates.length > 0) {
                    return candidates;
                }
            } catch {
                // Fall back to related query search
            }
        }

        const searchQuery = [seedTrack.author, seedTrack.title].filter(Boolean).join(" ").trim();
        if (!searchQuery) return [];
        const fallback = await this.search(searchQuery, 10, "direct");
        return fallback.items.filter(
            (item) =>
                item.id !== seedTrack.id && !excludeIds.has(item.id) && !excludeIds.has(item.url),
        );
    }

    public async healthCheck(): Promise<ProviderHealth> {
        const version = await this.ytdlp.getVersion();
        return {
            name: "youtube",
            healthy: Boolean(version),
            consecutiveFailures: version ? 0 : 1,
            lastError: version ? undefined : "yt-dlp binary unavailable",
            lastCheckedAt: Date.now(),
        };
    }
}
