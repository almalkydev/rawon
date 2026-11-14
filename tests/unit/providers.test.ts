import {
    classifyQuery,
    extractBestAudioFormat,
    extractYouTubeVideoId,
    isHlsFormat,
    LyricsService,
    SpotifyProvider,
} from "@rawon/providers";
import { ProviderError } from "@rawon/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("Provider Query Classification, Spotify Resolution & Lyrics", () => {
    it("classifies YouTube, YouTube Music, SoundCloud, Spotify, direct audio URLs, and search terms", () => {
        expect(classifyQuery("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({
            isUrl: true,
            sourceType: "youtube",
            kind: "track",
        });
        expect(classifyQuery("https://music.youtube.com/playlist?list=PL12345")).toMatchObject({
            isUrl: true,
            sourceType: "youtubemusic",
            kind: "playlist",
        });
        expect(classifyQuery("https://soundcloud.com/artist/sets/my-mix")).toMatchObject({
            isUrl: true,
            sourceType: "soundcloud",
            kind: "playlist",
        });
        expect(classifyQuery("https://soundcloud.com/artist/single-track")).toMatchObject({
            isUrl: true,
            sourceType: "soundcloud",
            kind: "track",
        });
        expect(classifyQuery("spotify:track:3n3Ppam7vgaVa1iaRUc9Lp")).toMatchObject({
            isUrl: true,
            sourceType: "spotify",
            kind: "track",
            normalizedUrl: "https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp",
        });
        expect(classifyQuery("https://open.spotify.com/intl-de/album/1A2B3C4D")).toMatchObject({
            isUrl: true,
            sourceType: "spotify",
            kind: "album",
        });
        expect(classifyQuery("https://example.org/audio/demo.opus?token=abc")).toMatchObject({
            isUrl: true,
            sourceType: "direct",
            kind: "track",
        });
        expect(classifyQuery("Blinding Lights The Weeknd")).toMatchObject({
            isUrl: false,
            sourceType: "unknown",
            kind: "unknown",
        });

        expect(extractYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
        expect(extractYouTubeVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    });

    it("resolves Spotify metadata to a playable equivalent source without faking direct Spotify audio", async () => {
        const resolvedQueries: string[] = [];
        const fetchMock = vi.fn(async (input: string | URL) => {
            const url = String(input);
            if (url.includes("accounts.spotify.com/api/token")) {
                return new Response(
                    JSON.stringify({ access_token: "sp_token_123", expires_in: 3600 }),
                    { status: 200 },
                );
            }
            if (url.includes("api.spotify.com/v1/tracks/abc123")) {
                return new Response(
                    JSON.stringify({
                        id: "abc123",
                        name: "Blinding Lights",
                        duration_ms: 200_000,
                        artists: [{ name: "The Weeknd" }],
                        external_urls: { spotify: "https://open.spotify.com/track/abc123" },
                        album: { images: [{ url: "https://i.scdn.co/image/art.jpg" }] },
                    }),
                    { status: 200 },
                );
            }
            return new Response("Not Found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const sp = new SpotifyProvider({
            clientId: "cid",
            clientSecret: "csec",
            resolvePlayableTrack: async (query) => {
                resolvedQueries.push(query);
                return {
                    id: "4NRXx6U8gfq",
                    title: query,
                    url: "https://www.youtube.com/watch?v=4NRXx6U8gfq",
                    duration: 200,
                    thumbnail: "",
                    author: "The Weeknd",
                    provider: "youtube",
                };
            },
        });

        const res = await sp.resolveUrl("spotify:track:abc123");
        expect(res.type).toBe("results");
        expect(res.items).toHaveLength(1);
        expect(res.items[0]?.provider).toBe("spotify");
        expect(res.items[0]?.resolvedBy).toBe("youtube");
        expect(res.items[0]?.playableUrl).toBe("https://www.youtube.com/watch?v=4NRXx6U8gfq");
        expect(res.items[0]?.url).toBe("https://open.spotify.com/track/abc123");
        expect(res.items[0]?.title).toBe("The Weeknd - Blinding Lights");
        expect(res.items[0]?.thumbnail).toBe("https://i.scdn.co/image/art.jpg");
        expect(resolvedQueries[0]).toContain("The Weeknd");

        const unconfigured = new SpotifyProvider({
            clientId: "",
            clientSecret: "",
            resolvePlayableTrack: async () => null,
        });
        await expect(unconfigured.resolveUrl("spotify:track:abc123")).rejects.toThrow(
            ProviderError,
        );
    });

    it("preserves Stegripe Bearer lyrics auth and falls back to LrcLib gracefully", async () => {
        const authHeaders: string[] = [];
        const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith("https://api.stegripe.org")) {
                const headers = init?.headers as Record<string, string> | undefined;
                const authVal = headers?.authorization ?? headers?.Authorization;
                if (authVal) {
                    authHeaders.push(authVal);
                }
                return new Response("Unauthorized", { status: 401 });
            }
            if (url.startsWith("https://lrclib.net/api/search")) {
                return new Response(
                    JSON.stringify([{ trackName: "Time", artistName: "Hans Zimmer" }]),
                    { status: 200 },
                );
            }
            if (url.startsWith("https://lrclib.net/api/get")) {
                return new Response(
                    JSON.stringify({
                        trackName: "Time",
                        artistName: "Hans Zimmer",
                        plainLyrics: "Instrumental dreams\nEchoes across time",
                    }),
                    { status: 200 },
                );
            }
            return new Response("Not Found", { status: 404 });
        });
        vi.stubGlobal("fetch", fetchMock);

        const lyrics = new LyricsService("https://api.stegripe.org", "stegripe_secret_tok");
        const result = await lyrics.getLyrics("Hans Zimmer - Time");

        expect(authHeaders).toEqual(["Bearer stegripe_secret_tok"]);
        expect(result?.source).toBe("lrclib");
        expect(result?.lyrics).toContain("Echoes across time");

        const health = await lyrics.getHealth();
        expect(health.map((h) => h.name)).toEqual(["stegripe", "lrclib"]);
    });

    it("handles null entries and null format items without throwing, and prefers progressive streams over HLS", () => {
        expect(extractBestAudioFormat(null as never)).toBeNull();
        expect(extractBestAudioFormat({ formats: [null as never] } as never)).toBeNull();

        const selected = extractBestAudioFormat({
            id: "track1",
            title: "Sample",
            formats: [
                null as never,
                {
                    url: "https://cf-hls-media.sndcdn.com/playlist/128.m3u8",
                    acodec: "aac",
                    vcodec: "none",
                    abr: 256,
                    ext: "m3u8",
                    protocol: "m3u8_native",
                },
                {
                    url: "https://rr1---sn.googlevideo.com/videoplayback?itag=251",
                    acodec: "opus",
                    vcodec: "none",
                    abr: 160,
                    ext: "webm",
                    protocol: "https",
                },
            ],
        });

        expect(selected?.url).toBe("https://rr1---sn.googlevideo.com/videoplayback?itag=251");
        expect(
            isHlsFormat({
                url: "https://cf-hls-media.sndcdn.com/playlist/128.m3u8",
                protocol: "m3u8_native",
                ext: "m3u8",
            }),
        ).toBe(true);
        expect(
            isHlsFormat({
                url: "https://rr1---sn.googlevideo.com/videoplayback?itag=251",
                protocol: "https",
                ext: "webm",
            }),
        ).toBe(false);
    });
});
