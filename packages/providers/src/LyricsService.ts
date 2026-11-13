import type { MetadataCacheClient } from "@rawon/cache";
import type { LyricsResult } from "@rawon/shared";
import type { LyricsProvider, ProviderHealth } from "./interfaces.js";

const DEFAULT_ICON = "https://cdn.stegripe.org/images/icon.png";

export class StegripeLyricsProvider implements LyricsProvider {
    public readonly name = "stegripe";

    public constructor(
        private readonly baseUrl: string,
        private readonly apiToken: string,
    ) {}

    public isConfigured(): boolean {
        return this.apiToken.length > 0;
    }

    public async fetchLyrics(query: string): Promise<LyricsResult | null> {
        if (!this.isConfigured()) {
            return null;
        }
        try {
            const url = `${this.baseUrl}/api/v1/lyrics?q=${encodeURIComponent(query)}`;
            const res = await fetch(url, {
                signal: AbortSignal.timeout(15_000),
                headers: {
                    authorization: `Bearer ${this.apiToken}`,
                },
            });
            if (!res.ok) return null;

            const data = (await res.json()) as {
                error?: boolean;
                song?: string;
                artist?: string;
                lyrics?: string;
                source?: string;
                url?: string;
            };
            if (data.error || !data.lyrics?.trim()) {
                return null;
            }
            return {
                song: data.song ?? null,
                artist: data.artist ?? null,
                lyrics: data.lyrics.trim(),
                albumArt: DEFAULT_ICON,
                synced: false,
                url: data.url ?? null,
                source: data.source ?? "stegripe",
            };
        } catch {
            return null;
        }
    }

    public async healthCheck(): Promise<ProviderHealth> {
        return {
            name: this.name,
            healthy: this.isConfigured(),
            consecutiveFailures: 0,
            lastError: this.isConfigured() ? undefined : "STEGRIPE_API_LYRICS_TOKEN not set",
            lastCheckedAt: Date.now(),
        };
    }
}

export class LrcLibLyricsProvider implements LyricsProvider {
    public readonly name = "lrclib";

    public async fetchLyrics(query: string): Promise<LyricsResult | null> {
        try {
            const cleanSong = query
                .replaceAll(/\(.*?\)|\[.*?\]|\b(?:official|video|audio|lyrics|hd|hq|mv)\b/giu, "")
                .trim();
            const parts = cleanSong.split(/\s*[-–—]\s*/u);
            const artist = parts.length > 1 ? (parts[0] ?? "").trim() : "";
            const title = parts.length > 1 ? parts.slice(1).join(" ").trim() : cleanSong;

            const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`;
            const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(6_000) });
            if (!searchRes.ok) return null;

            const candidates = (await searchRes.json()) as Array<{
                trackName?: string;
                artistName?: string;
            }>;
            if (!Array.isArray(candidates) || candidates.length === 0) {
                return null;
            }

            let selected = candidates[0];
            if (artist && title) {
                const better = candidates.find(
                    (c) =>
                        c.trackName?.toLowerCase().includes(title.toLowerCase()) &&
                        c.artistName?.toLowerCase().includes(artist.toLowerCase()),
                );
                if (better) selected = better;
            }
            if (!selected?.trackName) return null;

            const getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(selected.trackName)}&artist_name=${encodeURIComponent(selected.artistName ?? "")}`;
            const detailsRes = await fetch(getUrl, { signal: AbortSignal.timeout(6_000) });
            if (!detailsRes.ok) return null;

            const details = (await detailsRes.json()) as {
                trackName?: string;
                artistName?: string;
                plainLyrics?: string;
                syncedLyrics?: string;
            };

            let lyricsText = (details.plainLyrics || details.syncedLyrics || "").trim();
            if (!lyricsText) return null;

            lyricsText = lyricsText.replaceAll(/\[(\d{1,2}:\d{2}\.\d{2,3})\]/gu, "`[$1]`");

            return {
                song: details.trackName ?? selected.trackName ?? null,
                artist: details.artistName ?? selected.artistName ?? null,
                lyrics: lyricsText,
                albumArt: DEFAULT_ICON,
                synced: !details.plainLyrics && Boolean(details.syncedLyrics),
                url: null,
                source: "lrclib",
            };
        } catch {
            return null;
        }
    }

    public async healthCheck(): Promise<ProviderHealth> {
        return {
            name: this.name,
            healthy: true,
            consecutiveFailures: 0,
            lastCheckedAt: Date.now(),
        };
    }
}

export class LyricsService {
    private readonly providers: LyricsProvider[];

    public constructor(
        stegripeApiUrl: string,
        stegripeApiToken: string,
        private readonly metadataCache?: MetadataCacheClient,
    ) {
        this.providers = [
            new StegripeLyricsProvider(stegripeApiUrl, stegripeApiToken),
            new LrcLibLyricsProvider(),
        ];
    }

    public async getLyrics(query: string): Promise<LyricsResult | null> {
        const normalized = query.trim();
        if (!normalized) return null;

        const cacheKey = `lyrics:${normalized.toLowerCase()}`;
        if (this.metadataCache) {
            const cached = await this.metadataCache.getJson<LyricsResult>(cacheKey);
            if (cached) return cached;
        }

        for (const provider of this.providers) {
            const res = await provider.fetchLyrics(normalized);
            if (res) {
                await this.metadataCache?.setJson(cacheKey, res, 86_400);
                return res;
            }
        }
        return null;
    }

    public async getHealth(): Promise<ProviderHealth[]> {
        return Promise.all(this.providers.map((p) => p.healthCheck()));
    }
}
