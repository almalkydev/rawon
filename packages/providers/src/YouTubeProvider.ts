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
import {
    extractBestAudioFormat,
    isHlsFormat,
    type YtDlpClient,
    type YtDlpEntry,
} from "./YtDlpClient.js";
import { searchYouTubeMusicInnerTube, upgradeThumbnailUrl } from "./youtubeMusic.js";

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

    public constructor(private readonly ytdlp: YtDlpClient) {}

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
        if (mode === "dsp") {
            try {
                const items = await searchYouTubeMusicInnerTube(query, limit);
                if (items.length > 0) {
                    return { type: "selection", items };
                }
            } catch {
                // Fall back to ytsearch via yt-dlp cleanly
            }
        }

        const dump = await this.ytdlp.dumpJson(`ytsearch${limit}:${query}`, {
            flatPlaylist: true,
            playlistEnd: limit,
        });
        const items: Track[] = [];
        for (const entry of dump.entries ?? []) {
            if (!entry) continue;
            const mapped = mapEntryToTrack(entry);
            if (mapped) items.push(mapped);
        }
        return { type: "selection", items };
    }

    public async resolveUrl(url: string, kind: QueryKind): Promise<SearchResult> {
        const isCollection = kind === "playlist" || kind === "artist";
        const isYtm = isYouTubeMusicUrl(url);
        const dump = await this.ytdlp.dumpJson(url, {
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
        const dump = await this.ytdlp.dumpJson(sourceUrl, { noPlaylist: true });
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
        let primaryErr: unknown = null;

        try {
            entry = await this.ytdlp.dumpJson(target, {
                noPlaylist: true,
                format: "bestaudio[acodec=opus]/bestaudio/best",
                signal,
            });
        } catch (err) {
            primaryErr = err;
            if (err instanceof ProviderError && err.category === "age_restricted") {
                throw err;
            }
        }

        let fmt = extractBestAudioFormat(entry);

        // Fallback to multi-client YouTube extraction + broader format selector when default client drops formats
        if (!fmt?.url) {
            try {
                const fallbackEntry = await this.ytdlp.dumpJson(target, {
                    noPlaylist: true,
                    format: "bestaudio/best",
                    extractorArgs: "youtube:player_client=android_vr,mweb,web",
                    signal,
                });
                const fallbackFmt = extractBestAudioFormat(fallbackEntry);
                if (fallbackFmt?.url) {
                    entry = fallbackEntry;
                    fmt = fallbackFmt;
                }
            } catch (fallbackErr) {
                if (!primaryErr) primaryErr = fallbackErr;
            }
        }

        if (!fmt?.url || !entry) {
            if (primaryErr instanceof ProviderError) {
                throw primaryErr;
            }
            throw new ProviderError(
                `No playable audio format found for ${target}`,
                "unavailable",
                true,
                primaryErr,
            );
        }

        const isLive = entry.is_live === true || entry.live_status === "is_live";
        const videoId = extractYouTubeVideoId(track.id) ?? extractYouTubeVideoId(target);
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

        return {
            sourceType: "url",
            url: fmt.url,
            canonicalKey,
            container,
            codec,
            sampleRate,
            channels,
            bitrateBps: fmt.abr ? Math.round(fmt.abr * 1000) : undefined,
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
