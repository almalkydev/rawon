import { type PlaylistMetadata, ProviderError, type SearchResult, type Track } from "@rawon/shared";
import { classifyQuery } from "./QueryClassifier.js";

export type PlayableTrackResolverFn = (searchQuery: string) => Promise<Track | null>;

interface SpotifyTokenState {
    accessToken: string;
    expiresAt: number;
}

interface SpotifyArtist {
    name?: string;
}

interface SpotifyImage {
    url?: string;
}

interface SpotifyTrackObject {
    id?: string;
    name?: string;
    duration_ms?: number;
    external_urls?: { spotify?: string };
    external_ids?: { isrc?: string };
    artists?: SpotifyArtist[];
    album?: { name?: string; images?: SpotifyImage[] };
}

export interface SpotifyProviderOptions {
    clientId: string;
    clientSecret: string;
    market?: string;
    resolvePlayableTrack: PlayableTrackResolverFn;
}

export class SpotifyProvider {
    private readonly clientId: string;
    private readonly clientSecret: string;
    private readonly market: string;
    private readonly resolvePlayableTrack: PlayableTrackResolverFn;
    private tokenState: SpotifyTokenState | null = null;
    private inflightTokenPromise: Promise<string> | null = null;

    public constructor(options: SpotifyProviderOptions) {
        this.clientId = options.clientId;
        this.clientSecret = options.clientSecret;
        this.market = options.market ?? "US";
        this.resolvePlayableTrack = options.resolvePlayableTrack;
    }

    public isConfigured(): boolean {
        return this.clientId.length > 0 && this.clientSecret.length > 0;
    }

    public supportsUrl(url: string): boolean {
        return classifyQuery(url).sourceType === "spotify";
    }

    public async resolveUrl(url: string): Promise<SearchResult> {
        if (!this.isConfigured()) {
            throw new ProviderError(
                "Spotify API credentials (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) are not configured.",
                "validation",
                false,
            );
        }

        const classified = classifyQuery(url);
        const normalized = classified.normalizedUrl ?? url;
        const parsed = new URL(normalized);
        const parts = parsed.pathname.split("/").filter(Boolean);
        const idx = parts[0]?.startsWith("intl-") ? 1 : 0;
        const kind = parts[idx];
        const id = parts[idx + 1];

        if (!kind || !id) {
            throw new ProviderError(`Invalid Spotify URL: ${url}`, "validation", false);
        }

        if (kind === "track") {
            const spTrack = await this.apiGet<SpotifyTrackObject>(`/tracks/${id}`);
            const resolved = await this.mapAndResolveTrack(spTrack);
            return {
                type: "results",
                items: resolved ? [resolved] : [],
            };
        }

        if (kind === "playlist") {
            return this.resolvePlaylist(id, normalized);
        }

        if (kind === "album") {
            return this.resolveAlbum(id, normalized);
        }

        if (kind === "artist") {
            return this.resolveArtist(id, normalized);
        }

        throw new ProviderError(`Unsupported Spotify resource type: ${kind}`, "validation", false);
    }

    private async resolvePlaylist(id: string, url: string): Promise<SearchResult> {
        interface PlaylistPage {
            name?: string;
            external_urls?: { spotify?: string };
            images?: SpotifyImage[];
            owner?: { display_name?: string };
            tracks?: {
                items?: Array<{ track?: SpotifyTrackObject | null }>;
                next?: string | null;
            };
        }

        const first = await this.apiGet<PlaylistPage>(
            `/playlists/${id}?market=${encodeURIComponent(this.market)}`,
        );
        const spTracks: SpotifyTrackObject[] = [];
        let unavailableCount = 0;

        const collectPage = (
            pageItems: Array<{ track?: SpotifyTrackObject | null }> | undefined,
        ) => {
            for (const row of pageItems ?? []) {
                if (row.track?.name) {
                    spTracks.push(row.track);
                } else {
                    unavailableCount += 1;
                }
            }
        };

        collectPage(first.tracks?.items);
        let nextUrl = first.tracks?.next ?? null;

        while (nextUrl && spTracks.length < 500) {
            const page = await this.apiGetAbsolute<{
                items?: Array<{ track?: SpotifyTrackObject | null }>;
                next?: string | null;
            }>(nextUrl);
            collectPage(page.items);
            nextUrl = page.next ?? null;
        }

        const { items, unresolvedCount } = await this.resolveBatch(spTracks, 4);
        const totalSkipped = unavailableCount + unresolvedCount;

        const playlist: PlaylistMetadata = {
            title: first.name ?? "Spotify Playlist",
            url: first.external_urls?.spotify ?? url,
            thumbnail: first.images?.[0]?.url ?? items[0]?.thumbnail ?? "",
            author: first.owner?.display_name,
            skippedCount: totalSkipped > 0 ? totalSkipped : undefined,
            skippedReason:
                totalSkipped > 0 ? (unresolvedCount > 0 ? "unresolved" : "unavailable") : undefined,
        };

        return { type: "results", items, playlist };
    }

    private async resolveAlbum(id: string, url: string): Promise<SearchResult> {
        interface AlbumPayload {
            name?: string;
            external_urls?: { spotify?: string };
            images?: SpotifyImage[];
            artists?: SpotifyArtist[];
            tracks?: {
                items?: SpotifyTrackObject[];
                next?: string | null;
            };
        }

        const album = await this.apiGet<AlbumPayload>(
            `/albums/${id}?market=${encodeURIComponent(this.market)}`,
        );
        const albumThumb = album.images?.[0]?.url;
        const spTracks: SpotifyTrackObject[] = [];

        const appendItems = (rawItems: SpotifyTrackObject[] | undefined) => {
            for (const item of rawItems ?? []) {
                spTracks.push({
                    ...item,
                    album: { name: album.name, images: album.images },
                });
            }
        };

        appendItems(album.tracks?.items);
        let nextUrl = album.tracks?.next ?? null;
        while (nextUrl && spTracks.length < 500) {
            const page = await this.apiGetAbsolute<{
                items?: SpotifyTrackObject[];
                next?: string | null;
            }>(nextUrl);
            appendItems(page.items);
            nextUrl = page.next ?? null;
        }

        const { items, unresolvedCount } = await this.resolveBatch(spTracks, 4);
        const playlist: PlaylistMetadata = {
            title: album.name ?? "Spotify Album",
            url: album.external_urls?.spotify ?? url,
            thumbnail: albumThumb ?? items[0]?.thumbnail ?? "",
            author:
                album.artists
                    ?.map((a) => a.name)
                    .filter(Boolean)
                    .join(", ") || undefined,
            skippedCount: unresolvedCount > 0 ? unresolvedCount : undefined,
            skippedReason: unresolvedCount > 0 ? "unresolved" : undefined,
        };

        return { type: "results", items, playlist };
    }

    private async resolveArtist(id: string, url: string): Promise<SearchResult> {
        interface ArtistPayload {
            name?: string;
            external_urls?: { spotify?: string };
            images?: SpotifyImage[];
        }
        interface TopTracksPayload {
            tracks?: SpotifyTrackObject[];
        }

        const [artist, top] = await Promise.all([
            this.apiGet<ArtistPayload>(`/artists/${id}`),
            this.apiGet<TopTracksPayload>(
                `/artists/${id}/top-tracks?market=${encodeURIComponent(this.market)}`,
            ),
        ]);

        const { items, unresolvedCount } = await this.resolveBatch(top.tracks ?? [], 4);
        const playlist: PlaylistMetadata = {
            title: artist.name ? `${artist.name} — Top Tracks` : "Spotify Artist",
            url: artist.external_urls?.spotify ?? url,
            thumbnail: artist.images?.[0]?.url ?? items[0]?.thumbnail ?? "",
            author: artist.name,
            skippedCount: unresolvedCount > 0 ? unresolvedCount : undefined,
            skippedReason: unresolvedCount > 0 ? "unresolved" : undefined,
        };
        return { type: "results", items, playlist };
    }

    private async resolveBatch(
        spTracks: readonly SpotifyTrackObject[],
        concurrency: number,
    ): Promise<{ items: Track[]; unresolvedCount: number }> {
        const results: Array<Track | null> = new Array(spTracks.length).fill(null);
        let cursor = 0;

        const workers = Array.from({ length: Math.min(concurrency, spTracks.length) }, async () => {
            while (cursor < spTracks.length) {
                const idx = cursor;
                cursor += 1;
                const sp = spTracks[idx];
                if (!sp) continue;
                results[idx] = await this.mapAndResolveTrack(sp).catch(() => null);
            }
        });

        await Promise.all(workers);

        const items = results.filter((t): t is Track => t !== null);
        return {
            items,
            unresolvedCount: results.length - items.length,
        };
    }

    private async mapAndResolveTrack(sp: SpotifyTrackObject): Promise<Track | null> {
        const title = sp.name?.trim();
        if (!title) return null;

        const artists =
            sp.artists
                ?.map((a) => a.name?.trim())
                .filter(Boolean)
                .join(", ") ?? "";
        const query = artists ? `${artists} - ${title}` : title;
        const equivalent = await this.resolvePlayableTrack(query);
        if (!equivalent) {
            return null;
        }

        const spUrl = sp.external_urls?.spotify;
        const spThumb = sp.album?.images?.[0]?.url;

        // Preserve accurate Spotify metadata & artwork while keeping the resolved authorized playableUrl
        return {
            id: equivalent.id,
            title: artists ? `${artists} - ${title}` : title,
            url: spUrl ?? equivalent.url,
            playableUrl: equivalent.playableUrl ?? equivalent.url,
            duration: sp.duration_ms ? Math.round(sp.duration_ms / 1000) : equivalent.duration,
            thumbnail: spThumb || equivalent.thumbnail,
            author: artists || equivalent.author,
            isLive: false,
            provider: "spotify",
            spotifyId: sp.id,
            spotifyUrl: spUrl,
            isrc: sp.external_ids?.isrc,
            album: sp.album?.name,
            resolvedBy: equivalent.provider,
        };
    }

    private async getAccessToken(): Promise<string> {
        if (this.tokenState && Date.now() < this.tokenState.expiresAt - 60_000) {
            return this.tokenState.accessToken;
        }
        if (this.inflightTokenPromise) {
            return this.inflightTokenPromise;
        }

        this.inflightTokenPromise = (async () => {
            const creds = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
            const res = await fetch("https://accounts.spotify.com/api/token", {
                method: "POST",
                signal: AbortSignal.timeout(10_000),
                headers: {
                    authorization: `Basic ${creds}`,
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: "grant_type=client_credentials",
            });

            if (!res.ok) {
                throw new ProviderError(
                    `Spotify authentication failed (HTTP ${res.status})`,
                    "permission",
                    false,
                );
            }
            const json = (await res.json()) as { access_token?: string; expires_in?: number };
            if (!json.access_token) {
                throw new ProviderError("Spotify returned empty access token", "permission", false);
            }

            this.tokenState = {
                accessToken: json.access_token,
                expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
            };
            return this.tokenState.accessToken;
        })().finally(() => {
            this.inflightTokenPromise = null;
        });

        return this.inflightTokenPromise;
    }

    private async apiGet<T>(path: string): Promise<T> {
        return this.apiGetAbsolute<T>(`https://api.spotify.com/v1${path}`);
    }

    private async apiGetAbsolute<T>(absoluteUrl: string): Promise<T> {
        const token = await this.getAccessToken();
        const res = await fetch(absoluteUrl, {
            signal: AbortSignal.timeout(12_000),
            headers: {
                authorization: `Bearer ${token}`,
            },
        });
        if (res.status === 429) {
            throw new ProviderError("Spotify API rate limit reached", "rate_limit", true);
        }
        if (!res.ok) {
            throw new ProviderError(
                `Spotify API error (HTTP ${res.status})`,
                "unavailable",
                res.status >= 500,
            );
        }
        return (await res.json()) as T;
    }
}
