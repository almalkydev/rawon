import type { Track } from "@rawon/shared";

export interface TrackMatchContext {
    /** Raw user search query or combined artist + title query */
    query: string;
    /** Optional canonical track title (e.g. from Spotify or primary Track) */
    targetTitle?: string;
    /** Optional canonical artist names (e.g. from Spotify or primary Track.author) */
    targetArtists?: readonly string[];
    /** Optional reference duration in seconds (e.g. from Spotify duration_ms or primary Track) */
    targetDurationSeconds?: number;
}

export interface ScoredTrackCandidate {
    track: Track;
    score: number;
}

const NOISE_TAG_REGEX =
    /[[(]\s*(?:official\s*(?:music\s*)?(?:video|audio|lyric(?:s)?(?:\s*video)?|visualizer)|lyric(?:s)?(?:\s*video)?|audio|visualizer|hd|hq|4k|remastered(?:\s+\d{4})?|explicit|clean|clean\s+version|explicit\s+version|full\s*song|full\s*audio|mv|m\/v|topic)\s*[\])]/giu;

const FEAT_CLAUSE_REGEX = /\b(?:feat\.?|ft\.?|featuring)\s+[^([\])-]+/giu;

const VARIANT_PATTERNS = {
    remix: /\b(?:remix|re-mix|rmx|bootleg|flip|vip\s*mix|club\s*mix|extended\s*mix|dj\s*mix|mashup|mash-up|megamix|blend|rework)\b/iu,
    edit: /\b(?:tiktok\s*edit|fan\s*edit|amv\s*edit|sped\s*edit|slowed\s*edit|nightcore\s*edit)\b/iu,
    speedPitch:
        /\b(?:slowed|reverb|sped\s*up|speed\s*up|nightcore|daycore|8d|8d\s*audio|16d|bass\s*boost(?:ed)?|chopped\s*(?:and|&|n)\s*screwed|pitched|chipmunk)\b/iu,
    cover: /\b(?:cover|covered\s+by|tribute|in\s+the\s+style\s+of|made\s+famous\s+by|karaoke|instrumental|backing\s+track|type\s+beat|reprod|ai\s+cover|ai\s+version|parody|lullaby\s+version|8-bit\s+version|piano\s+version|guitar\s+version)\b/iu,
    live: /\b(?:live(?:\s+at|\s+from|\s+in|\s+version|\s+performance|\s+session|\s+lounge)?|concert|fancam|unplugged|tiny\s+desk)\b/iu,
    acoustic: /\b(?:acoustic|stripped|unplugged)\b/iu,
    nonSong:
        /\b(?:reaction|review|breakdown|tutorial|lesson|how\s+to\s+play|ringtone|snippet|preview|teaser|trailer|1\s*hour|10\s*hours|loop(?:ed)?|compilation|full\s+album)\b/iu,
} as const;

const KNOCKOFF_AUTHOR_REGEX =
    /\b(?:tribute|karaoke|8-bit|lullaby|made\s+famous|in\s+the\s+style|backing\s+tracks?|type\s+beat|instrumentals?|kidz\s+bop|cover\s+band|ai\s+music)\b/iu;

const STOP_WORDS = new Set([
    "official",
    "music",
    "video",
    "audio",
    "lyrics",
    "lyric",
    "visualizer",
    "song",
    "full",
    "hd",
    "hq",
    "4k",
    "the",
    "feat",
    "ft",
    "featuring",
    "topic",
    "prod",
    "by",
]);

export function normalizeMatchText(input: string): string {
    return input
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/gu, "")
        .toLowerCase()
        .replace(/['’`]/gu, "")
        .replace(/&/gu, " and ")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

export function stripTitleNoise(rawTitle: string): string {
    return rawTitle
        .replace(/\s*-\s*topic$/iu, "")
        .replace(NOISE_TAG_REGEX, " ")
        .replace(FEAT_CLAUSE_REGEX, " ")
        .replace(/\|.*$/u, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

export function tokenizeMatchText(input: string, includeStopWords = false): string[] {
    const normalized = normalizeMatchText(input);
    if (!normalized) return [];
    const tokens = normalized.split(" ").filter((t) => t.length > 0);
    if (includeStopWords) return tokens;
    const filtered = tokens.filter((t) => !STOP_WORDS.has(t) && (t.length > 1 || /\d/u.test(t)));
    return filtered.length > 0 ? filtered : tokens;
}

export function splitArtistNames(rawAuthor: string | undefined): string[] {
    if (!rawAuthor) return [];
    const cleaned = rawAuthor
        .replace(/\s*-\s*topic$/iu, "")
        .replace(/\s*vevo$/iu, "")
        .replace(/\s*official$/iu, "")
        .trim();
    if (!cleaned) return [];
    return cleaned
        .split(/(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|•|\/|;)/iu)
        .map((part) => part.trim())
        .filter(
            (part) => part.length > 0 && !/^(?:song|video|single|album|ep|artist)$/iu.test(part),
        );
}

export function parseArtistTitleFromQuery(query: string): {
    artistHint?: string;
    titleHint: string;
} {
    const cleaned = stripTitleNoise(query);
    const dashMatch = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(cleaned);
    if (dashMatch?.[1] && dashMatch[2]) {
        return {
            artistHint: dashMatch[1].trim(),
            titleHint: dashMatch[2].trim(),
        };
    }
    const byMatch = /^(.+?)\s+\bby\s+(.+)$/iu.exec(cleaned);
    if (byMatch?.[1] && byMatch[2]) {
        return {
            titleHint: byMatch[1].trim(),
            artistHint: byMatch[2].trim(),
        };
    }
    return { titleHint: cleaned };
}

export function scoreTrackCandidate(track: Track, context: TrackMatchContext): number {
    const referenceText = `${context.query} ${context.targetTitle ?? ""} ${(context.targetArtists ?? []).join(" ")}`;
    const candidateFullText = `${track.title} ${track.author ?? ""}`;

    let score = 0;

    // 1. Variant / Knock-off penalties (only when NOT requested in the query/target)
    if (
        VARIANT_PATTERNS.remix.test(candidateFullText) &&
        !VARIANT_PATTERNS.remix.test(referenceText)
    ) {
        score -= 95;
    }
    if (
        VARIANT_PATTERNS.edit.test(candidateFullText) &&
        !VARIANT_PATTERNS.edit.test(referenceText)
    ) {
        score -= 90;
    }
    if (
        VARIANT_PATTERNS.speedPitch.test(candidateFullText) &&
        !VARIANT_PATTERNS.speedPitch.test(referenceText)
    ) {
        score -= 110;
    }
    if (
        VARIANT_PATTERNS.cover.test(candidateFullText) &&
        !VARIANT_PATTERNS.cover.test(referenceText)
    ) {
        score -= 115;
    }
    if (
        VARIANT_PATTERNS.live.test(candidateFullText) &&
        !VARIANT_PATTERNS.live.test(referenceText)
    ) {
        score -= 75;
    }
    if (
        VARIANT_PATTERNS.acoustic.test(candidateFullText) &&
        !VARIANT_PATTERNS.acoustic.test(referenceText)
    ) {
        score -= 65;
    }
    if (
        VARIANT_PATTERNS.nonSong.test(candidateFullText) &&
        !VARIANT_PATTERNS.nonSong.test(referenceText)
    ) {
        score -= 120;
    }

    if (
        track.author &&
        KNOCKOFF_AUTHOR_REGEX.test(track.author) &&
        !KNOCKOFF_AUTHOR_REGEX.test(referenceText)
    ) {
        score -= 100;
    }

    // 2. Determine target title and target artists
    const parsedQuery = parseArtistTitleFromQuery(context.query);
    const effectiveTitle = context.targetTitle
        ? stripTitleNoise(context.targetTitle)
        : parsedQuery.titleHint;
    const effectiveArtists =
        context.targetArtists && context.targetArtists.length > 0
            ? context.targetArtists.flatMap((a) => splitArtistNames(a))
            : parsedQuery.artistHint
              ? splitArtistNames(parsedQuery.artistHint)
              : [];

    const parsedCandidate = parseArtistTitleFromQuery(track.title);
    const candidateCleanTitle = stripTitleNoise(parsedCandidate.titleHint || track.title);
    const candidateTitleNorm = normalizeMatchText(candidateCleanTitle);
    const fullCandidateTitleNorm = normalizeMatchText(stripTitleNoise(track.title));
    const targetTitleNorm = normalizeMatchText(effectiveTitle);

    // 3. Exact & token title matching
    const titleTokens = tokenizeMatchText(effectiveTitle);
    const candidateTitleTokens = new Set([
        ...tokenizeMatchText(candidateCleanTitle),
        ...tokenizeMatchText(track.title),
    ]);
    const candidateAllTokens = new Set([
        ...candidateTitleTokens,
        ...tokenizeMatchText(track.author ?? ""),
    ]);

    if (
        targetTitleNorm &&
        (candidateTitleNorm === targetTitleNorm || fullCandidateTitleNorm === targetTitleNorm)
    ) {
        score += 65;
    } else if (
        targetTitleNorm &&
        (candidateTitleNorm.startsWith(targetTitleNorm) ||
            fullCandidateTitleNorm.includes(targetTitleNorm))
    ) {
        score += 38;
    }

    let matchedTitleTokenCount = 0;
    if (titleTokens.length > 0) {
        for (const tok of titleTokens) {
            if (candidateTitleTokens.has(tok)) {
                matchedTitleTokenCount += 1;
            }
        }
        const titleRatio = matchedTitleTokenCount / titleTokens.length;
        score += Math.round(titleRatio * 55);

        if (matchedTitleTokenCount === 0) {
            score -= 80;
        } else if (titleRatio < 0.5) {
            score -= 35;
        }
    }

    // Penalize excess unrequested words in candidate title that indicate a different song or bloat
    const targetAndArtistTokenSet = new Set([
        ...titleTokens,
        ...effectiveArtists.flatMap((a) => tokenizeMatchText(a)),
        ...tokenizeMatchText(context.query),
    ]);
    const extraCandidateTitleTokens = [...tokenizeMatchText(candidateCleanTitle)].filter(
        (tok) => !targetAndArtistTokenSet.has(tok),
    );
    if (extraCandidateTitleTokens.length > 0) {
        score -= Math.min(35, extraCandidateTitleTokens.length * 7);
    }

    // 4. Overall query token coverage (crucial when query is free-form "Artist Song" without a dash)
    const queryTokens = tokenizeMatchText(context.query);
    if (queryTokens.length > 0) {
        let matchedQueryTokens = 0;
        for (const tok of queryTokens) {
            if (candidateAllTokens.has(tok)) {
                matchedQueryTokens += 1;
            }
        }
        const queryCoverage = matchedQueryTokens / queryTokens.length;
        score += Math.round(queryCoverage * 45);
        if (matchedQueryTokens === 0) {
            score -= 90;
        }
    }

    // 5. Artist accuracy matching
    const candidateArtistTokens = new Set([
        ...tokenizeMatchText(track.author ?? ""),
        ...(parsedCandidate.artistHint ? tokenizeMatchText(parsedCandidate.artistHint) : []),
        ...tokenizeMatchText(track.url),
    ]);

    if (effectiveArtists.length > 0) {
        const primaryArtistTokens = tokenizeMatchText(effectiveArtists[0] ?? "");
        const allTargetArtistTokens = effectiveArtists.flatMap((a) => tokenizeMatchText(a));

        let matchedArtistTokens = 0;
        for (const tok of allTargetArtistTokens) {
            if (candidateArtistTokens.has(tok) || candidateAllTokens.has(tok)) {
                matchedArtistTokens += 1;
            }
        }

        const primaryMatched =
            primaryArtistTokens.length > 0 &&
            primaryArtistTokens.every(
                (tok) => candidateArtistTokens.has(tok) || candidateAllTokens.has(tok),
            );

        if (primaryMatched) {
            score += 45;
        } else if (matchedArtistTokens > 0) {
            score += 25;
        } else {
            // Known target artist is completely absent from candidate author/title/url
            score -= 60;
        }
    }

    // 6. Official channel / release signals
    const rawAuthor = track.author ?? "";
    if (/-\s*topic$/iu.test(rawAuthor)) {
        score += 28;
    } else if (/vevo$/iu.test(rawAuthor) || /\bofficial\b/iu.test(rawAuthor)) {
        score += 16;
    }

    if (/\b(?:official\s+audio)\b/iu.test(track.title)) {
        score += 20;
    } else if (/\b(?:official\s+(?:music\s+)?video|official\s+visualizer)\b/iu.test(track.title)) {
        score += 10;
    }

    if (track.provider === "youtubemusic") {
        score += 12;
    }

    // 7. Duration accuracy & preview/compilation filtering
    const targetDur = context.targetDurationSeconds ?? 0;
    if (track.isLive && !/\blive\b/iu.test(referenceText)) {
        score -= 80;
    }

    if (track.duration > 0) {
        // Reject 30s Go+ / short snippets unless target itself is short
        if (track.duration <= 35 && (targetDur === 0 || targetDur > 40)) {
            score -= 140;
        }

        // Penalize long compilations/mixes (> 12 mins) when searching for a normal track
        if (
            track.duration > 720 &&
            targetDur <= 420 &&
            !/\b(?:mix|set|album|hour|extended|concert)\b/iu.test(referenceText)
        ) {
            score -= 75;
        }

        if (targetDur > 0) {
            const diff = Math.abs(track.duration - targetDur);
            if (diff <= 2) {
                score += 45;
            } else if (diff <= 5) {
                score += 35;
            } else if (diff <= 12) {
                score += 20;
            } else if (diff <= 25) {
                score += 5;
            } else if (diff > 90) {
                score -= 75;
            } else if (diff > 45) {
                score -= 40;
            } else {
                score -= 15;
            }
        }
    }

    return score;
}

export function rankTrackCandidates(
    candidates: readonly Track[],
    context: TrackMatchContext,
): ScoredTrackCandidate[] {
    const scored = candidates.map((track, idx) => ({
        track,
        // Small positional tie-breaker (max 4 pts) preserves provider relevance when scores are equal
        score: scoreTrackCandidate(track, context) + Math.max(0, 4 - idx),
        idx,
    }));

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.idx - b.idx;
    });

    return scored.map(({ track, score }) => ({ track, score }));
}

export function selectBestMatchingTrack(
    candidates: readonly Track[],
    context: TrackMatchContext,
    minScore = -40,
): Track | null {
    if (candidates.length === 0) return null;
    const ranked = rankTrackCandidates(candidates, context);
    const best = ranked[0];
    if (!best || best.score < minScore) {
        return null;
    }
    return best.track;
}
