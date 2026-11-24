import type { StreamDescriptor, Track } from "@rawon/shared";
import { rankTrackCandidates } from "./trackMatcher.js";

const SC_WEB_ORIGIN = "https://soundcloud.com";
const SC_API_V2 = "https://api-v2.soundcloud.com";
const SC_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

interface SoundCloudTranscoding {
    url?: string;
    preset?: string;
    snipped?: boolean;
    format?: {
        protocol?: string;
        mime_type?: string;
    };
}

interface SoundCloudApiTrack {
    id?: number;
    title?: string;
    permalink_url?: string;
    duration?: number;
    full_duration?: number;
    artwork_url?: string | null;
    policy?: string;
    monetization_model?: string;
    user?: {
        username?: string;
        Avatar_url?: string;
        avatar_url?: string | null;
    };
    media?: {
        transcodings?: SoundCloudTranscoding[];
    };
}

let cachedClientId: string | null = null;
let clientIdExpiresAt = 0;
let inflightClientIdPromise: Promise<string | null> | null = null;

const trackDataCache = new Map<string, { raw: SoundCloudApiTrack; expiresAt: number }>();

function cacheRawTrack(raw: SoundCloudApiTrack): void {
    const expiresAt = Date.now() + 600_000;
    if (trackDataCache.size > 200) {
        const oldestKey = trackDataCache.keys().next().value;
        if (oldestKey) trackDataCache.delete(oldestKey);
    }
    if (raw.id) {
        trackDataCache.set(String(raw.id), { raw, expiresAt });
    }
    if (raw.permalink_url) {
        trackDataCache.set(raw.permalink_url, { raw, expiresAt });
    }
}

function getCachedRawTrack(keys: readonly string[]): SoundCloudApiTrack | null {
    const now = Date.now();
    for (const key of keys) {
        if (!key) continue;
        const hit = trackDataCache.get(key);
        if (hit && hit.expiresAt > now) {
            return hit.raw;
        }
    }
    return null;
}

async function fetchText(
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
): Promise<{ status: number; text: string } | null> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "GET",
            headers: {
                "User-Agent": SC_USER_AGENT,
                Accept: "*/*",
            },
            signal: controller.signal,
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return { status: res.status, text: "" };
        }
        const text = await res.text();
        return { status: res.status, text };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

export async function getSoundCloudClientId(
    forceRefresh = false,
    signal?: AbortSignal,
): Promise<string | null> {
    if (!forceRefresh && cachedClientId && Date.now() < clientIdExpiresAt) {
        return cachedClientId;
    }
    if (!forceRefresh && inflightClientIdPromise) {
        return inflightClientIdPromise;
    }

    inflightClientIdPromise = (async () => {
        const home = await fetchText(SC_WEB_ORIGIN, 3_500, signal);
        if (!home?.text?.includes("a-v2.sndcdn.com")) {
            return null;
        }
        const scriptUrls = [
            ...home.text.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/gu),
        ].map((m) => m[1] ?? "");
        const candidates = scriptUrls.filter(Boolean).slice(-5).reverse();

        for (const scriptUrl of candidates) {
            if (signal?.aborted) return null;
            const js = await fetchText(scriptUrl, 3_500, signal);
            if (!js?.text) continue;
            const match =
                /client_id\s*:\s*"([a-zA-Z0-9]{32})"/u.exec(js.text) ??
                /client_id="([a-zA-Z0-9]{32})"/u.exec(js.text) ??
                /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/u.exec(js.text);
            if (match?.[1]) {
                cachedClientId = match[1];
                clientIdExpiresAt = Date.now() + 6 * 3_600_000;
                return cachedClientId;
            }
        }
        return null;
    })().finally(() => {
        inflightClientIdPromise = null;
    });

    return inflightClientIdPromise;
}

function mapApiTrack(raw: SoundCloudApiTrack): Track | null {
    const id = raw.id ? String(raw.id) : "";
    const url = raw.permalink_url?.trim() ?? "";
    const title = raw.title?.trim() ?? "";
    if (!url || !title) return null;

    // SoundCloud Go+ SNIPPET tracks only stream 30 seconds
    const isSnippet =
        raw.policy?.toUpperCase() === "SNIPPET" ||
        raw.policy?.toUpperCase() === "BLOCK" ||
        Boolean(raw.media?.transcodings?.length && raw.media.transcodings.every((t) => t.snipped));
    const effectiveMs = isSnippet ? Math.min(raw.duration ?? 30_000, 30_000) : (raw.duration ?? 0);
    const duration = effectiveMs > 0 ? Math.round(effectiveMs / 1000) : 0;

    const rawArtwork = raw.artwork_url || raw.user?.avatar_url || "";
    const thumbnail = rawArtwork ? rawArtwork.replace("-large.", "-t500x500.") : "";

    cacheRawTrack(raw);

    return {
        id: id || url,
        title,
        url,
        duration,
        thumbnail,
        author: raw.user?.username?.trim() || undefined,
        isLive: false,
        provider: "soundcloud",
    };
}

export async function searchSoundCloudFast(
    query: string,
    limit = 10,
    signal?: AbortSignal,
): Promise<Track[] | null> {
    let clientId = await getSoundCloudClientId(false, signal);
    if (!clientId) return null;

    const fetchSearch = async (cid: string) => {
        const params = new URLSearchParams({
            q: query,
            limit: String(Math.max(limit * 2, 12)),
            client_id: cid,
        });
        return fetchText(`${SC_API_V2}/search/tracks?${params.toString()}`, 4_000, signal);
    };

    let res = await fetchSearch(clientId);
    if (res && (res.status === 401 || res.status === 403)) {
        clientId = await getSoundCloudClientId(true, signal);
        if (!clientId) return null;
        res = await fetchSearch(clientId);
    }
    if (!res?.text) return null;

    try {
        const parsed = JSON.parse(res.text) as { collection?: SoundCloudApiTrack[] };
        if (!Array.isArray(parsed.collection)) return null;
        const tracks: Track[] = [];
        for (const item of parsed.collection) {
            if (item.policy?.toUpperCase() === "BLOCK") continue;
            const mapped = mapApiTrack(item);
            if (mapped) tracks.push(mapped);
        }
        return rankTrackCandidates(tracks, { query })
            .slice(0, limit)
            .map((r) => r.track);
    } catch {
        return null;
    }
}

export async function resolveSoundCloudStreamFast(
    track: Track,
    signal?: AbortSignal,
): Promise<StreamDescriptor | null> {
    let clientId = await getSoundCloudClientId(false, signal);
    if (!clientId) return null;

    let rawTrack = getCachedRawTrack([track.id, track.url]);
    if (!rawTrack && track.url.startsWith("http")) {
        const resolveParams = new URLSearchParams({
            url: track.url,
            client_id: clientId,
        });
        let resolvedRes = await fetchText(
            `${SC_API_V2}/resolve?${resolveParams.toString()}`,
            4_000,
            signal,
        );
        if (resolvedRes && (resolvedRes.status === 401 || resolvedRes.status === 403)) {
            clientId = await getSoundCloudClientId(true, signal);
            if (!clientId) return null;
            resolveParams.set("client_id", clientId);
            resolvedRes = await fetchText(
                `${SC_API_V2}/resolve?${resolveParams.toString()}`,
                4_000,
                signal,
            );
        }
        if (resolvedRes?.text) {
            try {
                const parsed = JSON.parse(resolvedRes.text) as SoundCloudApiTrack;
                if (parsed?.media?.transcodings) {
                    cacheRawTrack(parsed);
                    rawTrack = parsed;
                }
            } catch {
                // Fall back to yt-dlp
            }
        }
    }

    const transcodings = rawTrack?.media?.transcodings?.filter((t) => t.url && !t.snipped) ?? [];
    if (transcodings.length === 0) return null;

    // Prefer progressive HTTP audio first (zero HLS segment overhead), then high-bitrate AAC/Opus HLS
    const ordered = [...transcodings].sort((a, b) => {
        const aProg = a.format?.protocol === "progressive" ? 1 : 0;
        const bProg = b.format?.protocol === "progressive" ? 1 : 0;
        if (aProg !== bProg) return bProg - aProg;
        const aAac160 = a.preset?.includes("160") ? 1 : 0;
        const bAac160 = b.preset?.includes("160") ? 1 : 0;
        if (aAac160 !== bAac160) return bAac160 - aAac160;
        const aOpus = a.format?.mime_type?.includes("opus") ? 1 : 0;
        const bOpus = b.format?.mime_type?.includes("opus") ? 1 : 0;
        return bOpus - aOpus;
    });

    for (const transcoding of ordered) {
        if (!transcoding.url || signal?.aborted) continue;
        const sep = transcoding.url.includes("?") ? "&" : "?";
        const streamMetaRes = await fetchText(
            `${transcoding.url}${sep}client_id=${encodeURIComponent(clientId)}`,
            3_500,
            signal,
        );
        if (!streamMetaRes?.text) continue;
        try {
            const parsed = JSON.parse(streamMetaRes.text) as { url?: string };
            if (!parsed.url) continue;

            const isHls = transcoding.format?.protocol === "hls" || parsed.url.includes(".m3u8");
            const mime = (transcoding.format?.mime_type ?? "").toLowerCase();
            const codec = mime.includes("opus")
                ? "opus"
                : mime.includes("mp4a")
                  ? "mp4a.40.2"
                  : "mp3";
            const container = isHls
                ? "m3u8"
                : mime.includes("ogg")
                  ? "ogg"
                  : mime.includes("mp4")
                    ? "m4a"
                    : "mp3";
            const durationSec = rawTrack?.duration
                ? Math.round(rawTrack.duration / 1000)
                : track.duration;

            return {
                sourceType: "url",
                url: parsed.url,
                canonicalKey: `soundcloud:${rawTrack?.id ?? (track.id || track.url)}`,
                container,
                codec,
                sampleRate: codec === "opus" ? 48_000 : 44_100,
                channels: 2,
                bitrateBps: transcoding.preset?.includes("160") ? 160_000 : 128_000,
                durationSeconds: durationSec,
                isLive: false,
                seekable: true,
                directPassthroughEligible: false,
                headers: { "User-Agent": SC_USER_AGENT },
                resolvedAt: Date.now(),
                expiresAt: Date.now() + 900_000,
            };
        } catch {
            // Try next transcoding
        }
    }

    return null;
}
