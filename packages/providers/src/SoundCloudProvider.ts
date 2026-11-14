import {
    type PlaylistMetadata,
    ProviderError,
    type SearchResult,
    type StreamDescriptor,
    type Track,
} from "@rawon/shared";
import type { ClassifiedQuery, MediaProvider, ProviderHealth, QueryKind } from "./interfaces.js";
import { classifyQuery } from "./QueryClassifier.js";
import {
    extractBestAudioFormat,
    isHlsFormat,
    type YtDlpClient,
    type YtDlpEntry,
} from "./YtDlpClient.js";

function positiveDuration(val: unknown): number {
    return typeof val === "number" && Number.isFinite(val) && val > 0 ? Math.floor(val) : 0;
}

function mapSoundCloudEntry(entry: YtDlpEntry): Track | null {
    const id = entry.id?.trim() ?? "";
    const url = (entry.webpage_url ?? entry.original_url ?? entry.url ?? "").trim();
    const title = (entry.title ?? entry.fulltitle ?? "").trim();
    if ((!id && !url) || !title || !url) {
        return null;
    }

    const candidates = entry.thumbnails ?? [];
    const thumb = entry.thumbnail ?? candidates[candidates.length - 1]?.url ?? "";

    return {
        id: id || url,
        title,
        url,
        duration: positiveDuration(entry.duration),
        thumbnail: thumb,
        author:
            (entry.artist ?? entry.uploader ?? entry.channel ?? entry.creator)?.trim() || undefined,
        isLive: entry.is_live === true,
        provider: "soundcloud",
    };
}

export class SoundCloudProvider implements MediaProvider {
    public readonly name = "soundcloud" as const;

    public constructor(private readonly ytdlp: YtDlpClient) {}

    public supportsUrl(url: string): boolean {
        return this.classifyUrl(url) !== null;
    }

    public classifyUrl(url: string): ClassifiedQuery | null {
        const classified = classifyQuery(url);
        return classified.sourceType === "soundcloud" ? classified : null;
    }

    public async search(query: string, limit = 10): Promise<SearchResult> {
        const dump = await this.ytdlp.dumpJson(`scsearch${limit}:${query}`, {
            flatPlaylist: true,
            playlistEnd: limit,
        });
        const items: Track[] = [];
        for (const entry of dump.entries ?? []) {
            if (!entry) continue;
            const mapped = mapSoundCloudEntry(entry);
            if (mapped) items.push(mapped);
        }
        return { type: "selection", items };
    }

    public async resolveUrl(url: string, kind: QueryKind): Promise<SearchResult> {
        const isCollection = kind === "playlist" || kind === "artist";
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
                const mapped = mapSoundCloudEntry(entry);
                if (!mapped) {
                    skippedCount += 1;
                    continue;
                }
                items.push(mapped);
            }
            const playlist: PlaylistMetadata = {
                title: (
                    dump.playlist_title ??
                    dump.title ??
                    dump.playlist ??
                    "SoundCloud Set"
                ).trim(),
                url: (dump.webpage_url ?? dump.original_url ?? url).trim(),
                thumbnail: dump.thumbnail ?? items[0]?.thumbnail ?? "",
                author: (dump.uploader ?? dump.channel ?? dump.artist)?.trim() || undefined,
                skippedCount: skippedCount > 0 ? skippedCount : undefined,
                skippedReason: skippedCount > 0 ? "unavailable" : undefined,
            };
            return { type: "results", items, playlist };
        }

        const single = mapSoundCloudEntry(dump);
        return { type: "results", items: single ? [single] : [] };
    }

    public async hydrateTrack(track: Track): Promise<Track> {
        const dump = await this.ytdlp.dumpJson(track.url, { noPlaylist: true });
        const hydrated = mapSoundCloudEntry(dump);
        return hydrated
            ? {
                  ...track,
                  ...hydrated,
                  thumbnail: hydrated.thumbnail || track.thumbnail,
              }
            : track;
    }

    public async getStreamDescriptor(
        track: Track,
        signal?: AbortSignal,
    ): Promise<StreamDescriptor> {
        const entry = await this.ytdlp.dumpJson(track.url, {
            noPlaylist: true,
            format: "bestaudio/best",
            signal,
        });
        const fmt = extractBestAudioFormat(entry);
        if (!fmt?.url) {
            throw new ProviderError(
                `No SoundCloud audio format for ${track.url}`,
                "unavailable",
                true,
            );
        }

        const codec = fmt.acodec?.toLowerCase();
        const container = fmt.ext?.toLowerCase();
        const passthrough =
            !isHlsFormat(fmt) &&
            Boolean(codec?.includes("opus")) &&
            (container === "ogg" || container === "opus") &&
            fmt.asr === 48_000 &&
            (fmt.audio_channels ?? 2) === 2;

        return {
            sourceType: "url",
            url: fmt.url,
            canonicalKey: `soundcloud:${track.id || track.url}`,
            container,
            codec,
            sampleRate: fmt.asr,
            channels: fmt.audio_channels ?? 2,
            bitrateBps: fmt.abr ? Math.round(fmt.abr * 1000) : undefined,
            durationSeconds: positiveDuration(entry.duration) || track.duration,
            isLive: false,
            seekable: true,
            directPassthroughEligible: passthrough,
            headers: fmt.http_headers ?? entry.http_headers,
            resolvedAt: Date.now(),
            expiresAt: Date.now() + 1800_000,
        };
    }

    public async healthCheck(): Promise<ProviderHealth> {
        const version = await this.ytdlp.getVersion();
        return {
            name: "soundcloud",
            healthy: Boolean(version),
            consecutiveFailures: version ? 0 : 1,
            lastError: version ? undefined : "yt-dlp binary unavailable",
            lastCheckedAt: Date.now(),
        };
    }
}
