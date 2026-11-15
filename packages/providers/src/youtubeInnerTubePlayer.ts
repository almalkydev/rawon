import { createHash } from "node:crypto";
import { setDefaultResultOrder } from "node:dns";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { YtDlpEntry, YtDlpFormatEntry } from "./YtDlpClient.js";

// Prefer IPv4 DNS resolution so YouTube/googlevideo URLs signed for IPv4 never 403 over IPv6
try {
    setDefaultResultOrder("ipv4first");
} catch {
    // Ignore in environments where DNS order cannot be changed
}

const SW_JS_DATA_URL = "https://www.youtube.com/sw.js_data";
const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const YOUTUBE_ORIGIN = "https://www.youtube.com";

interface InnerTubeClientSpec {
    name: string;
    clientId: string;
    clientVersion: string;
    userAgent: string;
    clientContext: Record<string, unknown>;
    thirdParty?: Record<string, unknown>;
}

const PRIMARY_CLIENTS: readonly InnerTubeClientSpec[] = [
    {
        name: "VISIONOS",
        clientId: "101",
        clientVersion: "0.1",
        userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        clientContext: {
            clientName: "VISIONOS",
            clientVersion: "0.1",
            deviceMake: "Apple",
            deviceModel: "RealityDevice14,1",
            osName: "visionOS",
            osVersion: "1.3.21O771",
            hl: "en",
            gl: "US",
        },
    },
];

const MOBILE_CLIENTS: readonly InnerTubeClientSpec[] = [
    {
        name: "IOS",
        clientId: "5",
        clientVersion: "20.03.02",
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
    {
        name: "ANDROID",
        clientId: "3",
        clientVersion: "20.10.38",
        userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
        clientContext: {
            clientName: "ANDROID",
            clientVersion: "20.10.38",
            androidSdkVersion: 34,
            osName: "Android",
            osVersion: "14",
            hl: "en",
            gl: "US",
        },
    },
];

const AUTHENTICATED_CLIENTS: readonly InnerTubeClientSpec[] = [
    ...PRIMARY_CLIENTS,
    {
        name: "TVHTML5",
        clientId: "7",
        clientVersion: "7.20250312.16.00",
        userAgent:
            "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version (unlike Gecko) v8/8.8.278.8-jit gles Starboard/14, SystemIntegratorName_ATV_2023/FirmwareVersion (Cobalt, Unknown)",
        clientContext: {
            clientName: "TVHTML5",
            clientVersion: "7.20250312.16.00",
            hl: "en",
            gl: "US",
        },
    },
    {
        name: "WEB_EMBEDDED_PLAYER",
        clientId: "56",
        clientVersion: "1.20250310.01.00",
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        clientContext: {
            clientName: "WEB_EMBEDDED_PLAYER",
            clientVersion: "1.20250310.01.00",
            hl: "en",
            gl: "US",
        },
        thirdParty: {
            embedUrl: "https://www.youtube.com/",
        },
    },
];

interface ParsedYouTubeCookieAuth {
    cookiesPath: string;
    mtimeMs: number;
    cookieHeader: string;
    sapisid: string | null;
}

let cachedCookieAuth: ParsedYouTubeCookieAuth | null = null;

function loadYouTubeAuthFromCookiesFile(
    cookiesPath: string | null | undefined,
): ParsedYouTubeCookieAuth | null {
    if (!cookiesPath) return null;
    try {
        if (!existsSync(cookiesPath)) return null;
        const st = statSync(cookiesPath);
        if (
            cachedCookieAuth &&
            cachedCookieAuth.cookiesPath === cookiesPath &&
            cachedCookieAuth.mtimeMs === st.mtimeMs
        ) {
            return cachedCookieAuth;
        }

        const raw = readFileSync(cookiesPath, "utf8");
        const cookieMap = new Map<string, string>();
        for (const rawLine of raw.split(/\r?\n/u)) {
            const line = rawLine.trim();
            if (!line) continue;
            const isHttpOnly = line.startsWith("#HttpOnly_");
            if (line.startsWith("#") && !isHttpOnly) continue;
            const effective = isHttpOnly ? line.slice("#HttpOnly_".length) : line;
            const cols = effective.split("\t");
            if (cols.length < 7) continue;
            const domain = (cols[0] ?? "").toLowerCase();
            if (!domain.includes("youtube.com") && !domain.includes("google.com")) {
                continue;
            }
            const name = (cols[5] ?? "").trim();
            const value = cols.slice(6).join("\t").trim();
            if (!name || !value) continue;
            if (!cookieMap.has(name) || domain.includes("youtube.com")) {
                cookieMap.set(name, value);
            }
        }

        if (cookieMap.size === 0) return null;
        const cookieHeader = [...cookieMap.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
        const sapisid =
            cookieMap.get("SAPISID") ??
            cookieMap.get("__Secure-3PAPISID") ??
            cookieMap.get("__Secure-1PAPISID") ??
            null;

        cachedCookieAuth = {
            cookiesPath,
            mtimeMs: st.mtimeMs,
            cookieHeader,
            sapisid,
        };
        return cachedCookieAuth;
    } catch {
        return null;
    }
}

function buildSapisidHashHeader(sapisid: string): string {
    const ts = Math.floor(Date.now() / 1000);
    const digest = createHash("sha1").update(`${ts} ${sapisid} ${YOUTUBE_ORIGIN}`).digest("hex");
    return `SAPISIDHASH ${ts}_${digest} SAPISID1PHASH ${ts}_${digest} SAPISID3PHASH ${ts}_${digest}`;
}

export function extractVisitorDataFromSwJsData(text: string): string | null {
    if (!text.startsWith(")]}'")) return null;
    try {
        const jsonText = text.replace(/^\)\]\}'\s*/u, "");
        const parsed = JSON.parse(jsonText) as unknown[];
        const row = (parsed?.[0] as unknown[])?.[2] as unknown[];
        const inner = (row?.[0] as unknown[])?.[0] as unknown[];
        const candidate = inner?.[13];
        if (typeof candidate === "string" && candidate.length >= 16) {
            return candidate;
        }
    } catch {
        // Fall through to regex extraction
    }

    const cgMatch = /"(Cg[A-Za-z0-9_%-]{18,})"/u.exec(text);
    if (cgMatch?.[1]) {
        return cgMatch[1];
    }
    const genericMatch = /"([A-Za-z0-9_-]{20,}%3D(?:%3D)?)"/u.exec(text);
    return genericMatch?.[1] ?? null;
}

export interface InnerTubePlayerOptions {
    cookiesPath?: string | null;
    visitorData?: string | null;
    forceRefreshVisitorData?: boolean;
}

let cachedVisitorData: { value: string; expiresAt: number; cookieKey: string } | null = null;
let inflightVisitorPromise: Promise<string | null> | null = null;

export async function getOrFetchYouTubeVisitorData(
    signal?: AbortSignal,
    options?: InnerTubePlayerOptions,
): Promise<string | null> {
    const cookieAuth = loadYouTubeAuthFromCookiesFile(options?.cookiesPath);
    const cookieKey = cookieAuth ? `${cookieAuth.cookiesPath}:${cookieAuth.mtimeMs}` : "anon";

    if (
        !options?.forceRefreshVisitorData &&
        cachedVisitorData &&
        cachedVisitorData.expiresAt > Date.now() &&
        cachedVisitorData.cookieKey === cookieKey
    ) {
        return cachedVisitorData.value;
    }
    if (inflightVisitorPromise && !options?.forceRefreshVisitorData) {
        return inflightVisitorPromise;
    }

    inflightVisitorPromise = (async () => {
        try {
            const headers: Record<string, string> = {
                "user-agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            };
            if (cookieAuth?.cookieHeader) {
                headers.cookie = cookieAuth.cookieHeader;
            }
            const res = await fetch(SW_JS_DATA_URL, {
                method: "GET",
                signal: signal ?? AbortSignal.timeout(2_500),
                headers,
            });
            if (!res.ok) return options?.visitorData ?? null;
            const text = await res.text();
            const token = extractVisitorDataFromSwJsData(text) ?? options?.visitorData ?? null;
            if (token) {
                cachedVisitorData = {
                    value: token,
                    expiresAt: Date.now() + 25 * 60_000,
                    cookieKey,
                };
            }
            return token;
        } catch {
            return options?.visitorData ?? null;
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
    visitorData: string | null,
    cookieAuth: ParsedYouTubeCookieAuth | null,
    signal?: AbortSignal,
): Promise<YtDlpEntry | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 3_500);

    try {
        const headers: Record<string, string> = {
            "content-type": "application/json",
            "user-agent": spec.userAgent,
            "x-youtube-client-name": spec.clientId,
            "x-youtube-client-version": spec.clientVersion,
            "x-goog-fieldmask":
                "playabilityStatus(status,reason),videoDetails(videoId,title,lengthSeconds,channelId,author,isLiveContent,thumbnail),streamingData(expiresInSeconds,formats,adaptiveFormats,hlsManifestUrl)",
        };
        if (visitorData) {
            headers["x-goog-visitor-id"] = visitorData;
        }
        if (cookieAuth?.cookieHeader) {
            headers.cookie = cookieAuth.cookieHeader;
            headers.origin = YOUTUBE_ORIGIN;
            headers["x-origin"] = YOUTUBE_ORIGIN;
            headers["x-goog-authuser"] = "0";
            if (cookieAuth.sapisid) {
                headers.authorization = buildSapisidHashHeader(cookieAuth.sapisid);
            }
        }

        const res = await fetch(INNERTUBE_PLAYER_URL, {
            method: "POST",
            signal: controller.signal,
            headers,
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        ...spec.clientContext,
                        ...(visitorData ? { visitorData } : {}),
                    },
                    ...(spec.thirdParty ? { thirdParty: spec.thirdParty } : {}),
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

        if (data.streamingData?.hlsManifestUrl) {
            formats.push({
                format_id: "234",
                url: data.streamingData.hlsManifestUrl,
                ext: "mp4",
                protocol: "m3u8_native",
                acodec: "mp4a.40.2",
                vcodec: "none",
                asr: 44_100,
                audio_channels: 2,
                abr: 132,
                http_headers: {
                    "User-Agent": spec.userAgent,
                },
            });
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
            extractor:
                spec.name === "VISIONOS" ? "youtube:innertube:visionos" : "youtube:innertube",
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

async function raceClientSpecs(
    videoId: string,
    specs: readonly InnerTubeClientSpec[],
    visitorData: string | null,
    cookieAuth: ParsedYouTubeCookieAuth | null,
    signal?: AbortSignal,
): Promise<YtDlpEntry | null> {
    const raceController = new AbortController();
    const onParentAbort = () => raceController.abort();
    signal?.addEventListener("abort", onParentAbort, { once: true });

    try {
        const entry = await Promise.any(
            specs.map(async (spec) => {
                const res = await querySingleInnerTubeClient(
                    videoId,
                    spec,
                    visitorData,
                    cookieAuth,
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

/**
 * Resolves direct YouTube audio stream formats in ~200ms via mobile InnerTube API
 * without spawning a Python yt-dlp process. Returns null if unavailable or in mocked test environments.
 */
export async function resolveYouTubeInnerTubePlayer(
    videoId: string,
    signal?: AbortSignal,
    options?: InnerTubePlayerOptions,
): Promise<YtDlpEntry | null> {
    if (!videoId || signal?.aborted) return null;

    const visitorData = await getOrFetchYouTubeVisitorData(signal, options);
    if (signal?.aborted) {
        return null;
    }

    const cookieAuth = loadYouTubeAuthFromCookiesFile(options?.cookiesPath);

    // 1. Primary VISIONOS InnerTube client (with cookieAuth immediately when available so VPS IPs don't waste an RTT)
    const primaryEntry = await raceClientSpecs(
        videoId,
        PRIMARY_CLIENTS,
        visitorData,
        cookieAuth,
        signal,
    );
    if (primaryEntry) {
        return primaryEntry;
    }

    // 2. If cookieAuth was used and failed (e.g. expired cookies), try unauthenticated VISIONOS, or vice-versa
    if (cookieAuth && !signal?.aborted) {
        const unauthPrimary = await raceClientSpecs(
            videoId,
            PRIMARY_CLIENTS,
            visitorData,
            null,
            signal,
        );
        if (unauthPrimary) {
            return unauthPrimary;
        }
        const authFallback = await raceClientSpecs(
            videoId,
            AUTHENTICATED_CLIENTS.slice(1),
            visitorData,
            cookieAuth,
            signal,
        );
        if (authFallback) {
            return authFallback;
        }
    }

    // 3. Fallback unauthenticated mobile clients
    if (!signal?.aborted) {
        return raceClientSpecs(videoId, MOBILE_CLIENTS, visitorData, null, signal);
    }

    return null;
}
