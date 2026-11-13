import { MemoryLruCache } from "@rawon/cache";
import { decodeHtmlEntities, type Track } from "@rawon/shared";
import { extractYouTubeVideoId } from "./QueryClassifier.js";

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

export async function searchYouTubeMusicInnerTube(
    query: string,
    limit = 10,
    signal?: AbortSignal,
): Promise<Track[]> {
    const response = await fetch(INNERTUBE_SEARCH_URL, {
        method: "POST",
        signal: signal ?? AbortSignal.timeout(8_000),
        headers: {
            "content-type": "application/json",
            "user-agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            origin: "https://music.youtube.com",
            referer: "https://music.youtube.com/",
        },
        body: JSON.stringify({
            context: INNERTUBE_CONTEXT,
            query,
            // Params filter for Songs ("EgWKAQIIAWoKEAMQBBAJEAoQBQ==") when searching tracks
            params: "EgWKAQIIAWoKEAMQBBAJEAoQBQ==",
        }),
    });

    if (!response.ok) {
        throw new Error(`YouTube Music InnerTube search returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const rawItems: MusicShelfRendererItem[] = [];
    walkShelves(payload, rawItems);

    const tracks: Track[] = [];
    const seen = new Set<string>();

    for (const item of rawItems) {
        if (tracks.length >= limit) break;
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

        const secondaryText = decodeHtmlEntities(
            extractTextFromRuns(cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs),
        );
        const parts = secondaryText.split("•").map((s) => s.trim());
        const durationPart = parts.find((p) => /^\d+:\d{2}(?::\d{2})?$/u.test(p)) ?? "";
        const duration = durationPart ? parseDurationText(durationPart) : 0;
        const author = parts[0] && !/^\d+:\d{2}$/u.test(parts[0]) ? parts[0] : undefined;

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
