import type { PlaylistMetadata, SearchResult, Track } from "@rawon/shared";
import { rankTrackCandidates } from "./trackMatcher.js";
import { upgradeThumbnailUrl } from "./youtubeMusic.js";

const YT_API_BASE = "https://www.googleapis.com/youtube/v3";

interface YouTubeApiThumbnail {
    url?: string;
    width?: number;
    height?: number;
}

interface YouTubeApiSearchItem {
    id?: {
        kind?: string;
        videoId?: string;
        playlistId?: string;
    };
    snippet?: {
        title?: string;
        channelTitle?: string;
        liveBroadcastContent?: string;
        thumbnails?: Record<string, YouTubeApiThumbnail | undefined>;
    };
}

interface YouTubeApiVideoItem {
    id?: string;
    snippet?: {
        title?: string;
        channelTitle?: string;
        liveBroadcastContent?: string;
        thumbnails?: Record<string, YouTubeApiThumbnail | undefined>;
    };
    contentDetails?: {
        duration?: string;
    };
    liveStreamingDetails?: {
        actualStartTime?: string;
        actualEndTime?: string;
    };
}

interface YouTubeApiPlaylistResponse {
    items?: Array<{
        snippet?: {
            title?: string;
            channelTitle?: string;
            thumbnails?: Record<string, YouTubeApiThumbnail | undefined>;
            resourceId?: { videoId?: string };
        };
        contentDetails?: {
            videoId?: string;
        };
    }>;
    nextPageToken?: string;
}

export function parseIso8601DurationSeconds(iso: string | undefined): number {
    if (!iso) return 0;
    const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/iu.exec(iso.trim());
    if (!match) return 0;
    const days = Number.parseInt(match[1] ?? "0", 10) || 0;
    const hours = Number.parseInt(match[2] ?? "0", 10) || 0;
    const minutes = Number.parseInt(match[3] ?? "0", 10) || 0;
    const seconds = Number.parseInt(match[4] ?? "0", 10) || 0;
    return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function pickApiThumbnail(
    thumbs: Record<string, YouTubeApiThumbnail | undefined> | undefined,
    videoId?: string,
): string {
    const raw =
        thumbs?.maxres?.url ??
        thumbs?.standard?.url ??
        thumbs?.high?.url ??
        thumbs?.medium?.url ??
        thumbs?.default?.url ??
        (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : "");
    return upgradeThumbnailUrl(raw);
}

function mapVideoItemToTrack(
    item: YouTubeApiVideoItem,
    provider: "youtube" | "youtubemusic" = "youtube",
): Track | null {
    const videoId = item.id?.trim();
    const title = item.snippet?.title?.trim();
    if (!videoId || !title) return null;
    if (title === "Private video" || title === "Deleted video") return null;

    const liveFlag = item.snippet?.liveBroadcastContent === "live";
    const duration = liveFlag ? 0 : parseIso8601DurationSeconds(item.contentDetails?.duration);
    const author = item.snippet?.channelTitle?.replace(/\s*-\s*Topic$/iu, "").trim() || undefined;

    return {
        id: videoId,
        title,
        url:
            provider === "youtubemusic"
                ? `https://music.youtube.com/watch?v=${videoId}`
                : `https://www.youtube.com/watch?v=${videoId}`,
        playableUrl:
            provider === "youtubemusic" ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
        duration,
        thumbnail: pickApiThumbnail(item.snippet?.thumbnails, videoId),
        author: item.snippet?.channelTitle?.trim() || author,
        isLive: liveFlag,
        provider,
    };
}

async function fetchJsonWithTimeout<T>(url: string, signal?: AbortSignal): Promise<T | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 5_000);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!res.ok) return null;
        return (await res.json()) as T;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

export async function fetchYouTubeVideosByIdsDataApi(
    videoIds: readonly string[],
    apiKey: string,
    provider: "youtube" | "youtubemusic" = "youtube",
    signal?: AbortSignal,
): Promise<Track[]> {
    const cleanIds = [...new Set(videoIds.map((id) => id.trim()).filter(Boolean))];
    if (cleanIds.length === 0 || !apiKey) return [];

    const out: Track[] = [];
    for (let i = 0; i < cleanIds.length; i += 50) {
        const batch = cleanIds.slice(i, i + 50);
        const params = new URLSearchParams({
            part: "snippet,contentDetails,liveStreamingDetails",
            id: batch.join(","),
            key: apiKey,
        });
        const data = await fetchJsonWithTimeout<{ items?: YouTubeApiVideoItem[] }>(
            `${YT_API_BASE}/videos?${params.toString()}`,
            signal,
        );
        if (!data?.items) continue;
        for (const item of data.items) {
            const mapped = mapVideoItemToTrack(item, provider);
            if (mapped) out.push(mapped);
        }
    }
    return out;
}

export async function searchYouTubeDataApi(
    query: string,
    apiKey: string,
    limit = 10,
    provider: "youtube" | "youtubemusic" = "youtube",
    signal?: AbortSignal,
): Promise<Track[] | null> {
    if (!apiKey || !query.trim()) return null;
    const maxResults = Math.min(25, Math.max(limit, 10));
    const params = new URLSearchParams({
        part: "snippet",
        type: "video",
        maxResults: String(maxResults),
        q: query.trim(),
        key: apiKey,
    });
    if (provider === "youtubemusic") {
        params.set("videoCategoryId", "10");
    }

    const searchData = await fetchJsonWithTimeout<{ items?: YouTubeApiSearchItem[] }>(
        `${YT_API_BASE}/search?${params.toString()}`,
        signal,
    );
    if (!searchData?.items) return null;

    const ids = searchData.items
        .map((item) => item.id?.videoId?.trim() ?? "")
        .filter((id) => id.length > 0);
    if (ids.length === 0) return [];

    const hydrated = await fetchYouTubeVideosByIdsDataApi(ids, apiKey, provider, signal);
    if (hydrated.length === 0) return null;

    return rankTrackCandidates(hydrated, { query })
        .slice(0, limit)
        .map((entry) => entry.track);
}

export async function resolveYouTubePlaylistDataApi(
    playlistId: string,
    playlistUrl: string,
    apiKey: string,
    signal?: AbortSignal,
): Promise<SearchResult | null> {
    if (!playlistId || !apiKey) return null;

    const metaParams = new URLSearchParams({
        part: "snippet",
        id: playlistId,
        key: apiKey,
    });
    const metaRes = await fetchJsonWithTimeout<YouTubeApiPlaylistResponse>(
        `${YT_API_BASE}/playlists?${metaParams.toString()}`,
        signal,
    );
    const playlistSnippet = metaRes?.items?.[0]?.snippet;

    const videoIds: string[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (pages < 4 && videoIds.length < 200 && !signal?.aborted) {
        pages += 1;
        const itemParams = new URLSearchParams({
            part: "contentDetails,snippet",
            playlistId,
            maxResults: "50",
            key: apiKey,
        });
        if (pageToken) itemParams.set("pageToken", pageToken);

        const page = await fetchJsonWithTimeout<YouTubeApiPlaylistResponse>(
            `${YT_API_BASE}/playlistItems?${itemParams.toString()}`,
            signal,
        );
        if (!page?.items) break;

        for (const entry of page.items) {
            const vid =
                entry.contentDetails?.videoId?.trim() ?? entry.snippet?.resourceId?.videoId?.trim();
            if (vid) videoIds.push(vid);
        }

        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
    }

    if (videoIds.length === 0) return null;
    const tracks = await fetchYouTubeVideosByIdsDataApi(videoIds, apiKey, "youtube", signal);
    if (tracks.length === 0) return null;

    const skippedCount = Math.max(0, videoIds.length - tracks.length);
    const playlist: PlaylistMetadata = {
        title: playlistSnippet?.title?.trim() || "YouTube Playlist",
        url: playlistUrl,
        thumbnail: pickApiThumbnail(playlistSnippet?.thumbnails) || tracks[0]?.thumbnail || "",
        author: playlistSnippet?.channelTitle?.trim() || undefined,
        skippedCount: skippedCount > 0 ? skippedCount : undefined,
        skippedReason: skippedCount > 0 ? "unavailable" : undefined,
    };

    return {
        type: "results",
        items: tracks,
        playlist,
    };
}
