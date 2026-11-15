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
    getOrFetchYouTubeVisitorData,
    resolveYouTubeInnerTubePlayer,
} from "./youtubeInnerTubePlayer.js";
import { searchYouTubeMusicInnerTube, upgradeThumbnailUrl } from "./youtubeMusic.js";

const YOUTUBE_FALLBACK_CLIENTS = [
    "youtube:player_client=android",
    "youtube:player_client=ios",
    "youtube:player_client=tv_simply",
    "youtube:player_client=android_vr",
    "youtube:player_client=web_embedded",
] as const;

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

export class YouTubeProvider implements MediaProvider {
    public readonly name = "youtube" as const;
    private readonly entryCache = new ResolvedEntryCache();
    private readonly inflightPlayerLookups = new Map<string, Promise<YtDlpEntry | null>>();
    private readonly forceProbeVideoIds = new Set<string>();
    private botBlockedUntil = 0;

    public constructor(private readonly ytdlp: YtDlpClient) {}

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

    private getInnerTubeOptions(): { cookiesPath?: string | null; visitorData?: string | null } {
        return {
            cookiesPath: this.ytdlp.getCookiesPath?.() ?? null,
            visitorData: this.ytdlp.getVisitorData?.() ?? null,
        };
    }

    private warmVisitorData(): void {
        void getOrFetchYouTubeVisitorData(undefined, this.getInnerTubeOptions())
            .then((vd) => {
                if (vd && !this.ytdlp.getVisitorData?.()) {
                    this.ytdlp.setVisitorData?.(vd);
                }
            })
            .catch(() => null);
    }

    private async resolveFastPlayerEntry(
        videoId: string,
        signal?: AbortSignal,
    ): Promise<YtDlpEntry | null> {
        const existing = this.inflightPlayerLookups.get(videoId);
        if (existing) {
            return existing;
        }
        const promise = resolveYouTubeInnerTubePlayer(videoId, signal, this.getInnerTubeOptions())
            .then((entry) => {
                if (entry) {
                    this.entryCache.store(
                        [
                            videoId,
                            `https://www.youtube.com/watch?v=${videoId}`,
                            `https://music.youtube.com/watch?v=${videoId}`,
                        ],
                        entry,
                    );
                }
                return entry;
            })
            .finally(() => {
                this.inflightPlayerLookups.delete(videoId);
            });
        this.inflightPlayerLookups.set(videoId, promise);
        return promise;
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

        if (!isCollection) {
            const singleVideoId = extractYouTubeVideoId(url);
            if (singleVideoId) {
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

        // Fast Path: ~150ms direct VISIONOS InnerTube player resolution (zero yt-dlp process spawn, zero probe RTT)
        if (!fmt?.url && videoId && !signal?.aborted) {
            const innerTubeEntry = await this.resolveFastPlayerEntry(videoId, signal);
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
                    if (mustProbe) {
                        this.forceProbeVideoIds.delete(videoId);
                    }
                    this.entryCache.store(cacheKeys, innerTubeEntry);
                }
            }
        }

        if (!fmt?.url && !signal?.aborted) {
            if (this.botBlockedUntil > Date.now()) {
                throw new ProviderError(
                    "YouTube requested bot-verification cookies",
                    "bot_detection",
                    false,
                );
            }
            try {
                entry = await this.ytdlp.dumpJson(target, {
                    noPlaylist: true,
                    format: "bestaudio[acodec=opus]/bestaudio/best",
                    signal,
                });
                fmt = await selectPlayableFormatFromEntry(entry, signal);
                if (fmt?.url && entry) {
                    this.botBlockedUntil = 0;
                    this.entryCache.store(cacheKeys, entry);
                }
            } catch (err) {
                primaryErr = err;
                if (err instanceof ProviderError && err.category === "age_restricted") {
                    throw err;
                }
            }
        }

        const wasBotDetected =
            primaryErr instanceof ProviderError && primaryErr.category === "bot_detection";

        // Dual-stack VPS hosts often trigger bot-checks on IPv6 while IPv4 passes
        if (!fmt?.url && wasBotDetected && !signal?.aborted) {
            try {
                const ipv4Entry = await this.ytdlp.dumpJson(target, {
                    noPlaylist: true,
                    format: "bestaudio[acodec=opus]/bestaudio/best",
                    forceIpv4: true,
                    signal,
                });
                const ipv4Fmt = await selectPlayableFormatFromEntry(ipv4Entry, signal);
                if (ipv4Fmt?.url) {
                    entry = ipv4Entry;
                    fmt = ipv4Fmt;
                    this.botBlockedUntil = 0;
                    this.entryCache.store(cacheKeys, ipv4Entry);
                }
            } catch (ipv4Err) {
                if (ipv4Err instanceof ProviderError && ipv4Err.category === "age_restricted") {
                    throw ipv4Err;
                }
            }
        }

        // Fallback across alternate player clients concurrently when default formats fail or return 403
        if (!fmt?.url && !signal?.aborted) {
            const raceController = new AbortController();
            const onParentAbort = () => raceController.abort();
            signal?.addEventListener("abort", onParentAbort, { once: true });

            try {
                const winner = await Promise.any(
                    YOUTUBE_FALLBACK_CLIENTS.map(async (extractorArgs) => {
                        const fallbackEntry = await this.ytdlp.dumpJson(target, {
                            noPlaylist: true,
                            format: "bestaudio/best",
                            extractorArgs,
                            forceIpv4: wasBotDetected,
                            // Mobile/VR/TV clients are skipped by yt-dlp if --cookies is passed
                            skipCookies: extractorArgs !== "youtube:player_client=web_embedded",
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
                this.entryCache.store(cacheKeys, winner.fallbackEntry);
            } catch (aggErr) {
                const errors =
                    aggErr instanceof AggregateError ? (aggErr.errors as unknown[]) : [aggErr];
                for (const fallbackErr of errors) {
                    if (
                        fallbackErr instanceof ProviderError &&
                        fallbackErr.category === "age_restricted"
                    ) {
                        throw fallbackErr;
                    }
                    if (!primaryErr && fallbackErr instanceof ProviderError) {
                        primaryErr = fallbackErr;
                    }
                }
                if (wasBotDetected) {
                    this.botBlockedUntil = Date.now() + 90_000;
                }
            } finally {
                signal?.removeEventListener("abort", onParentAbort);
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
