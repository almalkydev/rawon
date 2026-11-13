import { isValidHttpUrlSyntax } from "@rawon/shared";
import type { ClassifiedQuery, QueryKind } from "./interfaces.js";

const YOUTUBE_VIDEO_ID_PATTERN = /^[\w-]{11}$/u;
const SPOTIFY_URI_PATTERN = /^spotify:(track|playlist|album|artist):([a-zA-Z0-9]+)$/u;
const DIRECT_AUDIO_EXT_PATTERN = /\.(mp3|ogg|oga|opus|wav|flac|m4a|aac|webm|weba|mp4)(?:$|\?)/iu;

export function extractYouTubeVideoId(value: string | null | undefined): string | null {
    const raw = value?.trim() ?? "";
    if (!raw) return null;
    if (YOUTUBE_VIDEO_ID_PATTERN.test(raw)) {
        return raw;
    }

    try {
        const parsed = new URL(raw);
        const host = parsed.hostname.replace(/^www\./u, "").toLowerCase();
        if (host === "youtu.be") {
            const id = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
            return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
        }
        if (host === "youtube.com" || host === "music.youtube.com" || host === "m.youtube.com") {
            const v = parsed.searchParams.get("v")?.trim() ?? "";
            if (YOUTUBE_VIDEO_ID_PATTERN.test(v)) return v;
            const pathLast = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
            return YOUTUBE_VIDEO_ID_PATTERN.test(pathLast) ? pathLast : null;
        }
    } catch {
        return null;
    }
    return null;
}

export function isYouTubeMusicUrl(rawUrl: string): boolean {
    try {
        const parsed = new URL(rawUrl);
        return parsed.hostname.toLowerCase().includes("music.youtube.com");
    } catch {
        return false;
    }
}

export function classifyQuery(rawInput: string): ClassifiedQuery {
    const trimmed = rawInput.trim();

    const spotifyUriMatch = SPOTIFY_URI_PATTERN.exec(trimmed);
    if (spotifyUriMatch) {
        const kind = spotifyUriMatch[1] as QueryKind;
        const id = spotifyUriMatch[2] ?? "";
        return {
            raw: trimmed,
            isUrl: true,
            sourceType: "spotify",
            kind,
            normalizedUrl: `https://open.spotify.com/${kind}/${id}`,
        };
    }

    if (!isValidHttpUrlSyntax(trimmed)) {
        return {
            raw: trimmed,
            isUrl: false,
            sourceType: "unknown",
            kind: "unknown",
        };
    }

    const parsed = new URL(trimmed);
    const host = parsed.hostname.replace(/^www\./u, "").toLowerCase();
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (
        host === "music.youtube.com" ||
        host === "youtube.com" ||
        host === "m.youtube.com" ||
        host === "youtu.be"
    ) {
        const sourceType = host === "music.youtube.com" ? "youtubemusic" : "youtube";
        const hasListParam = parsed.searchParams.has("list");
        const hasVideoParam = parsed.searchParams.has("v") || host === "youtu.be";
        const firstPath = pathParts[0]?.toLowerCase() ?? "";

        let kind: QueryKind = "track";
        if (firstPath === "playlist" || (hasListParam && !hasVideoParam)) {
            kind = "playlist";
        } else if (firstPath.startsWith("@") || firstPath === "channel" || firstPath === "c") {
            kind = "artist";
        } else if (hasListParam && hasVideoParam) {
            // URL has both ?v= and ?list= — treat playlist URLs explicitly when list !== WL/LL/RD or check playlist vs single track
            kind = parsed.pathname === "/playlist" ? "playlist" : "track";
        }

        return {
            raw: trimmed,
            isUrl: true,
            sourceType,
            kind,
            normalizedUrl: parsed.toString(),
        };
    }

    if (
        host === "soundcloud.com" ||
        host === "m.soundcloud.com" ||
        host === "on.soundcloud.com" ||
        host === "snd.sc"
    ) {
        const isSets =
            pathParts.includes("sets") ||
            pathParts.includes("likes") ||
            pathParts.includes("tracks");
        return {
            raw: trimmed,
            isUrl: true,
            sourceType: "soundcloud",
            kind: isSets ? "playlist" : "track",
            normalizedUrl: parsed.toString(),
        };
    }

    if (host === "open.spotify.com") {
        // Handle optional /intl-xx/ prefix before resource type
        const idx = pathParts[0]?.startsWith("intl-") ? 1 : 0;
        const kindCandidate = pathParts[idx]?.toLowerCase();
        const kind: QueryKind =
            kindCandidate === "playlist" ||
            kindCandidate === "album" ||
            kindCandidate === "artist" ||
            kindCandidate === "track"
                ? kindCandidate
                : "unknown";
        return {
            raw: trimmed,
            isUrl: true,
            sourceType: "spotify",
            kind,
            normalizedUrl: parsed.toString(),
        };
    }

    const isDirectExt = DIRECT_AUDIO_EXT_PATTERN.test(parsed.pathname);
    return {
        raw: trimmed,
        isUrl: true,
        sourceType: isDirectExt ? "direct" : "unknown",
        kind: isDirectExt ? "track" : "unknown",
        normalizedUrl: parsed.toString(),
    };
}
