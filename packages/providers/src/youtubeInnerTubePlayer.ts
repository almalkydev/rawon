import { setDefaultResultOrder } from "node:dns";
import type { YtDlpEntry, YtDlpFormatEntry } from "./YtDlpClient.js";

// Prefer IPv4 DNS resolution so YouTube/googlevideo URLs signed for IPv4 never 403 over IPv6
try {
    setDefaultResultOrder("ipv4first");
} catch {
    // Ignore in environments where DNS order cannot be changed
}

const SW_JS_DATA_URL = "https://www.youtube.com/sw.js_data";
const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";

interface InnerTubeClientSpec {
    name: string;
    userAgent: string;
    clientContext: Record<string, unknown>;
}

const MOBILE_CLIENTS: readonly InnerTubeClientSpec[] = [
    {
        name: "ANDROID",
        userAgent: "com.google.android.youtube/20.03.35 (Linux; U; Android 14) gzip",
        clientContext: {
            clientName: "ANDROID",
            clientVersion: "20.03.35",
            androidSdkVersion: 34,
            osName: "Android",
            osVersion: "14",
            hl: "en",
            gl: "US",
        },
    },
    {
        name: "IOS",
        userAgent: "com.google.ios.youtube/20.03.02 (iPhone16,2; U; CPU iOS 18_2_1 like Mac OS X;)",
        clientContext: {
            clientName: "IOS",
            clientVersion: "20.03.02",
            deviceMake: "Apple",
            deviceModel: "iPhone16,2",
            osName: "iPhone",
            osVersion: "18.2.1.22C161",
            hl: "en",
            gl: "US",
        },
    },
];

let cachedVisitorData: { value: string; expiresAt: number } | null = null;
let inflightVisitorPromise: Promise<string | null> | null = null;

export async function getOrFetchYouTubeVisitorData(signal?: AbortSignal): Promise<string | null> {
    if (cachedVisitorData && cachedVisitorData.expiresAt > Date.now()) {
        return cachedVisitorData.value;
    }
    if (inflightVisitorPromise) {
        return inflightVisitorPromise;
    }

    inflightVisitorPromise = (async () => {
        try {
            const res = await fetch(SW_JS_DATA_URL, {
                method: "GET",
                signal: signal ?? AbortSignal.timeout(2_500),
                headers: {
                    "user-agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                },
            });
            if (!res.ok) return null;
            const text = await res.text();
            if (!text.startsWith(")]}'")) return null;
            const match = /"([A-Za-z0-9_-]{20,}%3D%3D)"/u.exec(text);
            const token = match?.[1] ?? null;
            if (token) {
                cachedVisitorData = {
                    value: token,
                    expiresAt: Date.now() + 25 * 60_000,
                };
            }
            return token;
        } catch {
            return null;
        } finally {
            inflightVisitorPromise = null;
        }
    })();

    return inflightVisitorPromise;
}

interface RawInnerTubeFormat {
    itag?: number;
    url?: string;
    mimeType?: string;
    bitrate?: number;
    averageBitrate?: number;
    audioSampleRate?: string | number;
    audioChannels?: number;
    approxDurationMs?: string | number;
}

interface RawInnerTubePlayerResponse {
    playabilityStatus?: {
        status?: string;
        reason?: string;
    };
    videoDetails?: {
        videoId?: string;
        title?: string;
        lengthSeconds?: string | number;
        channelId?: string;
        author?: string;
        isLiveContent?: boolean;
        thumbnail?: {
            thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
        };
    };
    streamingData?: {
        expiresInSeconds?: string | number;
        formats?: RawInnerTubeFormat[];
        adaptiveFormats?: RawInnerTubeFormat[];
        hlsManifestUrl?: string;
    };
}

function mapRawFormat(raw: RawInnerTubeFormat, userAgent: string): YtDlpFormatEntry | null {
    if (!raw.url || !raw.mimeType) return null;
    const mime = raw.mimeType.toLowerCase();
    const isAudio = mime.startsWith("audio/");
    const isMuxedVideo = mime.startsWith("video/") && raw.itag === 18;
    if (!isAudio && !isMuxedVideo) return null;

    const codecsMatch = /codecs="([^"]+)"/iu.exec(raw.mimeType);
    const codecStr = codecsMatch?.[1]?.toLowerCase() ?? "";

    let ext = "webm";
    let acodec = "opus";
    let vcodec = "none";

    if (mime.includes("mp4")) {
        ext = isAudio ? "m4a" : "mp4";
        acodec = codecStr.split(",")[0]?.trim() || "mp4a.40.2";
        vcodec = isAudio ? "none" : "avc1.42001E";
    } else if (mime.includes("webm")) {
        ext = "webm";
        acodec = codecStr || "opus";
        vcodec = isAudio ? "none" : "vp9";
    }

    const asr =
        typeof raw.audioSampleRate === "number"
            ? raw.audioSampleRate
            : typeof raw.audioSampleRate === "string"
              ? Number.parseInt(raw.audioSampleRate, 10) || undefined
              : undefined;
    const bps = raw.averageBitrate ?? raw.bitrate ?? 0;
    const abr = bps > 0 ? Math.round(bps / 1000) : undefined;

    return {
        format_id: raw.itag !== undefined ? String(raw.itag) : undefined,
        url: raw.url,
        ext,
        protocol: "https",
        acodec,
        vcodec,
        asr,
        audio_channels: raw.audioChannels ?? 2,
        abr,
        http_headers: {
            "User-Agent": userAgent,
        },
    };
}

async function querySingleInnerTubeClient(
    videoId: string,
    spec: InnerTubeClientSpec,
    visitorData: string,
    signal?: AbortSignal,
): Promise<YtDlpEntry | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 3_500);

    try {
        const res = await fetch(INNERTUBE_PLAYER_URL, {
            method: "POST",
            signal: controller.signal,
            headers: {
                "content-type": "application/json",
                "user-agent": spec.userAgent,
                "x-goog-visitor-id": visitorData,
            },
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        ...spec.clientContext,
                        visitorData,
                    },
                },
                contentCheckOk: true,
                racyCheckOk: true,
            }),
        });

        if (!res.ok) return null;
        const data = (await res.json()) as RawInnerTubePlayerResponse;
        if (data?.playabilityStatus?.status !== "OK") {
            return null;
        }

        const rawAdaptive = data.streamingData?.adaptiveFormats ?? [];
        const rawMuxed = data.streamingData?.formats ?? [];
        const formats: YtDlpFormatEntry[] = [];

        for (const item of [...rawAdaptive, ...rawMuxed]) {
            const mapped = mapRawFormat(item, spec.userAgent);
            if (mapped) {
                formats.push(mapped);
            }
        }

        if (formats.length === 0) {
            return null;
        }

        const details = data.videoDetails;
        const duration =
            typeof details?.lengthSeconds === "number"
                ? details.lengthSeconds
                : typeof details?.lengthSeconds === "string"
                  ? Number.parseInt(details.lengthSeconds, 10) || 0
                  : 0;
        const thumbs = details?.thumbnail?.thumbnails ?? [];

        return {
            id: details?.videoId || videoId,
            title: details?.title || videoId,
            webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
            duration,
            uploader: details?.author,
            channel: details?.author,
            is_live: details?.isLiveContent === true,
            thumbnails: thumbs,
            thumbnail: thumbs[thumbs.length - 1]?.url,
            http_headers: {
                "User-Agent": spec.userAgent,
            },
            formats,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

/**
 * Resolves direct YouTube audio stream formats in ~200ms via mobile InnerTube API
 * without spawning a Python yt-dlp process. Returns null if unavailable or in mocked test environments.
 */
export async function resolveYouTubeInnerTubePlayer(
    videoId: string,
    signal?: AbortSignal,
): Promise<YtDlpEntry | null> {
    if (!videoId || signal?.aborted) return null;

    const visitorData = await getOrFetchYouTubeVisitorData(signal);
    if (!visitorData || signal?.aborted) {
        return null;
    }

    const raceController = new AbortController();
    const onParentAbort = () => raceController.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
        const entry = await Promise.any(
            MOBILE_CLIENTS.map(async (spec) => {
                const res = await querySingleInnerTubeClient(
                    videoId,
                    spec,
                    visitorData,
                    raceController.signal,
                );
                if (!res) {
                    throw new Error(`InnerTube ${spec.name} returned no playable formats`);
                }
                return res;
            }),
        );
        raceController.abort();
        return entry;
    } catch {
        return null;
    } finally {
        signal?.removeEventListener("abort", onParentAbort);
    }
}
