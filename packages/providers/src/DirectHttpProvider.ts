import {
    assertSafePublicUrl,
    ExpiredStreamError,
    ProviderError,
    type SearchResult,
    type StreamDescriptor,
    type Track,
} from "@rawon/shared";
import { classifyQuery } from "./QueryClassifier.js";

const AUDIO_EXT_REGEX = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|weba|mp4)(?:$|\?)/iu;

function inferContainerAndCodec(
    contentType: string | null,
    url: string,
): {
    container?: string;
    codec?: string;
    passthrough: boolean;
} {
    const ct = contentType?.toLowerCase().split(";")[0]?.trim() ?? "";
    const lowerUrl = url.toLowerCase();

    if (
        ct === "audio/ogg" ||
        ct === "application/ogg" ||
        lowerUrl.includes(".ogg") ||
        lowerUrl.includes(".opus")
    ) {
        return { container: "ogg", codec: "opus", passthrough: false }; // verified dynamically via codec probe bytes!
    }
    if (ct === "audio/webm" || lowerUrl.includes(".webm")) {
        return { container: "webm", codec: "opus", passthrough: false };
    }
    if (ct === "audio/mpeg" || ct === "audio/mp3" || lowerUrl.includes(".mp3")) {
        return { container: "mp3", codec: "mp3", passthrough: false };
    }
    if (ct === "audio/flac" || ct === "audio/x-flac" || lowerUrl.includes(".flac")) {
        return { container: "flac", codec: "flac", passthrough: false };
    }
    if (ct === "audio/wav" || ct === "audio/x-wav" || lowerUrl.includes(".wav")) {
        return { container: "wav", codec: "pcm", passthrough: false };
    }
    if (ct === "audio/mp4" || ct === "audio/aac" || lowerUrl.includes(".m4a")) {
        return { container: "m4a", codec: "aac", passthrough: false };
    }
    return { container: undefined, codec: undefined, passthrough: false };
}

function filenameFromHeadersOrUrl(headers: Headers, url: string): string {
    const disp = headers.get("content-disposition");
    if (disp) {
        const match = /filename\*?=(?:UTF-8'')?"?([^";\n]+)"?/iu.exec(disp);
        if (match?.[1]) {
            return decodeURIComponent(match[1]);
        }
    }
    try {
        const parsed = new URL(url);
        const last = parsed.pathname.split("/").filter(Boolean).at(-1);
        if (last) return decodeURIComponent(last);
    } catch {
        // ignore
    }
    return "Direct Audio";
}

export class DirectHttpProvider {
    public supportsUrl(url: string): boolean {
        const c = classifyQuery(url);
        return c.sourceType === "direct" || (c.isUrl && c.sourceType === "unknown");
    }

    public async resolveDirectUrl(url: string): Promise<SearchResult> {
        const safeUrl = await assertSafePublicUrl(url);
        const target = safeUrl.toString();

        let title = target;
        let isAudio = AUDIO_EXT_REGEX.test(safeUrl.pathname);

        try {
            const headRes = await fetch(target, {
                method: "HEAD",
                redirect: "follow",
                signal: AbortSignal.timeout(8_000),
            });

            if (
                headRes.status === 401 ||
                headRes.status === 403 ||
                headRes.status === 404 ||
                headRes.status === 410
            ) {
                throw new ExpiredStreamError(
                    `Media URL unavailable (HTTP ${headRes.status})`,
                    headRes.status,
                );
            }

            if (headRes.ok) {
                const ct = headRes.headers.get("content-type")?.toLowerCase() ?? "";
                const disp = headRes.headers.get("content-disposition")?.toLowerCase() ?? "";
                if (
                    ct.startsWith("audio/") ||
                    ct === "application/ogg" ||
                    AUDIO_EXT_REGEX.test(disp) ||
                    isAudio
                ) {
                    isAudio = true;
                }
                title = filenameFromHeadersOrUrl(headRes.headers, target);
            }
        } catch (err) {
            if (err instanceof ExpiredStreamError) {
                throw err;
            }
            if (!isAudio) {
                throw new ProviderError(
                    `Unable to probe direct media URL: ${target}`,
                    "unavailable",
                    true,
                    err,
                );
            }
        }

        if (!isAudio) {
            throw new ProviderError(
                `URL does not point to a supported audio resource: ${target}`,
                "unavailable",
                false,
            );
        }

        const track: Track = {
            id: target,
            title,
            url: target,
            playableUrl: target,
            duration: 0,
            thumbnail: "",
            provider: safeUrl.hostname.includes("discordapp.") ? "attachment" : "direct",
        };

        return { type: "results", items: [track] };
    }

    public async getStreamDescriptor(
        track: Track,
        signal?: AbortSignal,
    ): Promise<StreamDescriptor> {
        const rawUrl = track.playableUrl || track.url;
        const safeUrl = await assertSafePublicUrl(rawUrl);
        const target = safeUrl.toString();

        const res = await fetch(target, {
            method: "HEAD",
            redirect: "follow",
            signal: signal ?? AbortSignal.timeout(8_000),
        }).catch(() => null);

        if (
            res &&
            (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410)
        ) {
            throw new ExpiredStreamError(
                `Direct media link expired or inaccessible (HTTP ${res.status})`,
                res.status,
            );
        }

        const ct = res?.headers.get("content-type") ?? null;
        const acceptRanges = res?.headers.get("accept-ranges")?.toLowerCase() === "bytes";
        const inferred = inferContainerAndCodec(ct, target);

        return {
            sourceType: "url",
            url: target,
            canonicalKey: `direct:${target}`,
            container: inferred.container,
            codec: inferred.codec,
            isLive: false,
            seekable: acceptRanges || true,
            directPassthroughEligible: inferred.passthrough,
            headers: track.headers,
            resolvedAt: Date.now(),
        };
    }
}
