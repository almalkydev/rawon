import { MemoryLruCache } from "@rawon/cache";
import { decodeHtmlEntities, type Track } from "@rawon/shared";
import { extractYouTubeVideoId } from "./QueryClassifier.js";
import { rankTrackCandidates } from "./trackMatcher.js";

const INNERTUBE_SEARCH_URL = "https://music.youtube.com/youtubei/v1/search?prettyPrint=false";
const INNERTUBE_CONTEXT = {
    client: {
        clientName: "WEB_REMIX",
        clientVersion: "1.20250101.01.00",
        hl: "en",
        gl: "US",
    },
};

const SQUARE_THUMB_CACHE = new MemoryLruCache<string, string>({
    maxEntries: 1000,
    ttlMs: 3_600_000,
});

export function upgradeThumbnailUrl(url: string | undefined): string {
    if (!url) return "";
    const trimmed = url.trim();
    if (!trimmed) return "";

    if (trimmed.includes("lh3.googleusercontent.com") || trimmed.includes("yt3.ggpht.com")) {
        return trimmed
            .replace(/=w\d+-h\d+[^&?]*/u, "=w720-h720-l90-rj")
            .replace(/=s\d+[^&?]*/u, "=s720-rj");
    }

    const vid =
        extractYouTubeVideoId(trimmed) ?? /\/vi(?:_webp)?\/([\w-]{11})\//u.exec(trimmed)?.[1];
    if (vid && !trimmed.includes("googleusercontent.com")) {
        return `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;
    }
    return trimmed;
}

export async function resolveSquareYouTubeMusicThumb(
    videoId: string,
    fallbackThumb = "",
): Promise<string> {
    const cached = SQUARE_THUMB_CACHE.get(videoId);
    if (cached) return cached;

    if (fallbackThumb?.includes("googleusercontent.com")) {
        const upgraded = upgradeThumbnailUrl(fallbackThumb);
        SQUARE_THUMB_CACHE.set(videoId, upgraded);
        return upgraded;
    }

    const fallback = upgradeThumbnailUrl(
        fallbackThumb || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    );
    SQUARE_THUMB_CACHE.set(videoId, fallback);
    return fallback;
}

function extractTextFromRuns(runs: unknown): string {
    if (!Array.isArray(runs)) return "";
    return runs
        .map((r) =>
            typeof r === "object" && r !== null && "text" in r
                ? String((r as { text: unknown }).text)
                : "",
        )
        .join("")
        .trim();
}

function parseDurationText(text: string): number {
    const parts = text
        .trim()
        .split(":")
        .map((p) => Number.parseInt(p, 10));
    if (parts.some((n) => !Number.isFinite(n))) return 0;
    if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
    if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
    return 0;
}

interface MusicShelfRendererItem {
    musicResponsiveListItemRenderer?: {
        playlistItemData?: { videoId?: string };
        overlay?: {
            musicItemThumbnailOverlayRenderer?: {
                content?: {
                    musicPlayButtonRenderer?: {
                        playNavigationEndpoint?: { watchEndpoint?: { videoId?: string } };
                    };
                };
            };
        };
        thumbnail?: {
            musicThumbnailRenderer?: {
                thumbnail?: { thumbnails?: Array<{ url?: string; width?: number }> };
            };
        };
        flexColumns?: Array<{
            musicResponsiveListItemFlexColumnRenderer?: {
                text?: { runs?: Array<{ text?: string; navigationEndpoint?: unknown }> };
            };
        }>;
    };
}

function walkShelves(node: unknown, out: MusicShelfRendererItem[]): void {
    if (Array.isArray(node)) {
        for (const item of node) walkShelves(item, out);
        return;
    }
    if (typeof node !== "object" || node === null) return;

    const record = node as Record<string, unknown>;
    if ("musicResponsiveListItemRenderer" in record) {
        out.push(record as MusicShelfRendererItem);
        return;
    }
    for (const val of Object.values(record)) {
        walkShelves(val, out);
    }
}

const MEDIA_TYPE_BADGE_REGEX =
    /^(?:song|video|single|album|ep|podcast|episode|playlist|artist|profile)$/iu;
const VIEW_OR_PLAY_COUNT_REGEX =
    /^\d+(?:[.,]\d+)?\s*[KMB]?\s*(?:views|plays|subscribers|listeners)$/iu;

function extractArtistFromSecondaryColumn(
    runs: Array<{ text?: string; navigationEndpoint?: unknown }> | undefined,
    parts: readonly string[],
): string | undefined {
    if (Array.isArray(runs)) {
        const artistNames: string[] = [];
        for (const run of runs) {
            const text = typeof run?.text === "string" ? decodeHtmlEntities(run.text).trim() : "";
            if (!text || text === "•" || text === "," || text === "&") continue;
            const navJson = run.navigationEndpoint ? JSON.stringify(run.navigationEndpoint) : "";
            if (
                navJson.includes("MUSIC_PAGE_TYPE_ARTIST") ||
                navJson.includes("MUSIC_PAGE_TYPE_USER_CHANNEL")
            ) {
                if (!artistNames.includes(text)) {
                    artistNames.push(text);
                }
            }
        }
        if (artistNames.length > 0) {
            return artistNames.join(" & ");
        }
    }

    const candidatePart = parts.find(
        (part) =>
            part.length > 0 &&
            !MEDIA_TYPE_BADGE_REGEX.test(part) &&
            !/^\d+:\d{2}(?::\d{2})?$/u.test(part) &&
            !VIEW_OR_PLAY_COUNT_REGEX.test(part),
    );
    return candidatePart || undefined;
}

async function fetchInnerTubeShelfTracks(
    query: string,
    maxPool: number,
    params: string | undefined,
    seen: Set<string>,
    signal?: AbortSignal,
): Promise<Track[]> {
    const bodyObj: Record<string, unknown> = {
        context: INNERTUBE_CONTEXT,
        query,
    };
    if (params) {
        bodyObj.params = params;
    }

    const response = await fetch(INNERTUBE_SEARCH_URL, {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(6_000),
        headers: {
            "content-type": "application/json",
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            origin: "https://music.youtube.com",
            referer: "https://music.youtube.com/",
        },
        body: JSON.stringify(bodyObj),
    });

    if (!response.ok) {
        throw new Error(`YouTube Music InnerTube search returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const rawItems: MusicShelfRendererItem[] = [];
    walkShelves(payload, rawItems);

    const tracks: Track[] = [];
    for (const item of rawItems) {
        if (tracks.length >= maxPool) break;
        const renderer = item.musicResponsiveListItemRenderer;
        if (!renderer) continue;

        const videoId =
            renderer.playlistItemData?.videoId ??
            renderer.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
                ?.playNavigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId || seen.has(videoId)) continue;

        const cols = renderer.flexColumns ?? [];
        const title = decodeHtmlEntities(
            extractTextFromRuns(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs),
        );
        if (!title) continue;

        const secondaryRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
        const secondaryText = decodeHtmlEntities(extractTextFromRuns(secondaryRuns));
        const parts = secondaryText.split("•").map((s) => s.trim());
        const durationPart = parts.find((p) => /^\d+:\d{2}(?::\d{2})?$/u.test(p)) ?? "";
        const duration = durationPart ? parseDurationText(durationPart) : 0;
        const author = extractArtistFromSecondaryColumn(secondaryRuns, parts);

        const thumbs = renderer.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails ?? [];
        const bestThumb = thumbs[thumbs.length - 1]?.url;

        seen.add(videoId);
        tracks.push({
            id: videoId,
            title,
            url: `https://music.youtube.com/watch?v=${videoId}`,
            playableUrl: `https://www.youtube.com/watch?v=${videoId}`,
            duration,
            thumbnail: await resolveSquareYouTubeMusicThumb(videoId, bestThumb),
            author,
            isLive: false,
            provider: "youtubemusic",
        });
    }

    return tracks;
}

export async function searchYouTubeMusicInnerTube(
    query: string,
    limit = 10,
    signal?: AbortSignal,
): Promise<Track[]> {
    const candidatePoolSize = Math.max(limit, 10);
    const seen = new Set<string>();

    // 1. Search official YouTube Music Songs shelf first ("EgWKAQIIAWoKEAMQBBAJEAoQBQ==")
    const songTracks = await fetchInnerTubeShelfTracks(
        query,
        candidatePoolSize,
        "EgWKAQIIAWoKEAMQBBAJEAoQBQ==",
        seen,
        signal,
    );

    const rankedSongs = rankTrackCandidates(songTracks, { query });
    const bestSongScore = rankedSongs[0]?.score ?? Number.NEGATIVE_INFINITY;

    // 2. If Songs shelf only returned a weak match, knock-off, or remix, merge unfiltered Top Result / Videos shelf
    if ((songTracks.length === 0 || bestSongScore < 60) && !signal?.aborted) {
        const unfilteredTracks = await fetchInnerTubeShelfTracks(
            query,
            candidatePoolSize,
            undefined,
            seen,
            signal,
        ).catch(() => [] as Track[]);

        if (unfilteredTracks.length > 0) {
            const combined = [...songTracks, ...unfilteredTracks];
            return rankTrackCandidates(combined, { query })
                .slice(0, limit)
                .map((r) => r.track);
        }
    }

    return rankedSongs.slice(0, limit).map((r) => r.track);
}
