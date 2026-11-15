import {
    classifyQuery,
    extractBestAudioFormat,
    extractVisitorDataFromSwJsData,
    extractYouTubeVideoId,
    hasUnrequestedVariant,
    isHlsFormat,
    LyricsService,
    listAudioFormatCandidates,
    ProviderRegistry,
    rankTrackCandidates,
    SpotifyProvider,
    searchYouTubeMusicInnerTube,
    selectBestMatchingTrack,
    YouTubeProvider,
    type YtDlpClient,
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

    it("ranks audio candidates cleanly, includes omitted-acodec HLS 234/233, excludes storyboards, and skips 403 URLs in YouTubeProvider", async () => {
        const ranked = listAudioFormatCandidates({
            id: "yt_403_test",
            title: "Track",
            formats: [
                {
                    format_id: "sb0",
                    url: "https://i.ytimg.com/sb/abc/storyboard.mhtml",
                    acodec: "none",
                    vcodec: "none",
                    ext: "mhtml",
                    protocol: "mhtml",
                },
                {
                    format_id: "139",
                    url: "https://rr1.googlevideo.com/videoplayback?itag=139",
                    acodec: "mp4a.40.5",
                    vcodec: "none",
                    abr: 48,
                    asr: 22050,
                    ext: "m4a",
                    protocol: "https",
                },
                {
                    format_id: "233",
                    url: "https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/233/file/index.m3u8",
                    vcodec: "none",
                    ext: "mp4",
                    protocol: "m3u8_native",
                },
                {
                    format_id: "234",
                    url: "https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/234/file/index.m3u8",
                    vcodec: "none",
                    ext: "mp4",
                    protocol: "m3u8_native",
                },
                {
                    format_id: "18",
                    url: "https://rr1.googlevideo.com/videoplayback?itag=18",
                    acodec: "mp4a.40.2",
                    vcodec: "avc1.42001E",
                    asr: 44100,
                    ext: "mp4",
                    protocol: "https",
                },
                {
                    format_id: "251",
                    url: "https://rr1.googlevideo.com/videoplayback?itag=251",
                    acodec: "opus",
                    vcodec: "none",
                    abr: 130,
                    asr: 48000,
                    audio_channels: 2,
                    ext: "webm",
                    protocol: "https",
                },
            ],
        });

        expect(ranked.map((f) => f.format_id)).toEqual(["251", "234", "139", "233", "18"]);

        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes("itag=251")) {
                    return new Response("", { status: 403 });
                }
                if (url.includes("itag/234")) {
                    return new Response(
                        "#EXTM3U\n#EXTINF:5.0,\nhttps://seg.googlevideo.com/sq/0/itag/234\n",
                        { status: 200 },
                    );
                }
                if (url.includes("seg.googlevideo.com/sq/0/itag/234")) {
                    return new Response(new Uint8Array([0, 1, 2, 3]), { status: 206 });
                }
                return new Response("", { status: 403 });
            }),
        );

        const ytdlpStub = {
            dumpJson: vi.fn(async () => ({
                id: "yt_403_test",
                title: "White Mustang",
                duration: 165,
                formats: ranked,
            })),
        } as unknown as YtDlpClient;

        const yt = new YouTubeProvider(ytdlpStub);
        const descriptor = await yt.getStreamDescriptor({
            id: "yt_403_test",
            title: "White Mustang",
            url: "https://www.youtube.com/watch?v=yt_403_test",
            duration: 165,
            thumbnail: "",
            author: "Lana Del Rey",
            provider: "youtube",
        });

        expect(descriptor.url).toContain("itag/234");
        expect(descriptor.directPassthroughEligible).toBe(false);
        expect(descriptor.bitrateBps).toBe(132_000);
    });

    it("falls back to alternate YouTube clients when all default formats 403, and forceFallbackProvider switches to SoundCloud", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes("android_client_ok")) {
                    return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
                }
                if (url.includes("cf-media.sndcdn.com/full.mp3")) {
                    return new Response(new Uint8Array([4, 5, 6]), { status: 206 });
                }
                return new Response("", { status: 403 });
            }),
        );

        const dumpJson = vi.fn(async (target: string, opts?: { extractorArgs?: string }) => {
            if (target.startsWith("scsearch")) {
                return {
                    entries: [
                        {
                            id: "sc_short",
                            title: "Summertime Sadness Preview",
                            url: "https://soundcloud.com/artist/preview",
                            webpage_url: "https://soundcloud.com/artist/preview",
                            duration: 30,
                            uploader: "Lana Del Rey",
                        },
                        {
                            id: "sc_full",
                            title: "Summertime Sadness",
                            url: "https://soundcloud.com/artist/summertime-sadness",
                            webpage_url: "https://soundcloud.com/artist/summertime-sadness",
                            duration: 265,
                            uploader: "Lana Del Rey",
                        },
                    ],
                };
            }
            if (target.includes("soundcloud.com")) {
                return {
                    id: "sc_full",
                    title: "Summertime Sadness",
                    webpage_url: "https://soundcloud.com/artist/summertime-sadness",
                    duration: 265,
                    uploader: "Lana Del Rey",
                    formats: [
                        {
                            format_id: "http_mp3",
                            url: "https://cf-media.sndcdn.com/full.mp3",
                            acodec: "mp3",
                            vcodec: "none",
                            abr: 128,
                            ext: "mp3",
                            protocol: "https",
                        },
                    ],
                };
            }
            if (!opts?.extractorArgs) {
                return {
                    id: "yt_vid",
                    title: "Summertime Sadness",
                    duration: 265,
                    formats: [
                        {
                            format_id: "251",
                            url: "https://rr1.googlevideo.com/videoplayback?itag=251",
                            acodec: "opus",
                            vcodec: "none",
                            abr: 130,
                            protocol: "https",
                        },
                    ],
                };
            }
            if (opts.extractorArgs === "youtube:player_client=android") {
                return {
                    id: "yt_vid",
                    title: "Summertime Sadness",
                    duration: 265,
                    formats: [
                        {
                            format_id: "18",
                            url: "https://rr2.googlevideo.com/videoplayback?android_client_ok=1",
                            acodec: "mp4a.40.2",
                            vcodec: "avc1.42001E",
                            ext: "mp4",
                            asr: 44100,
                            protocol: "https",
                        },
                    ],
                };
            }
            return { id: "yt_vid", title: "Summertime Sadness", formats: [] };
        });

        const ytdlpStub = { dumpJson } as unknown as YtDlpClient;
        const registry = new ProviderRegistry({ ytdlp: ytdlpStub });

        const ytTrack = {
            id: "yt_vid",
            title: "Summertime Sadness",
            url: "https://www.youtube.com/watch?v=yt_vid",
            duration: 265,
            thumbnail: "",
            author: "Lana Del Rey",
            provider: "youtube" as const,
        };

        const androidDesc = await registry.getStreamDescriptor(ytTrack);
        expect(androidDesc.url).toContain("android_client_ok");

        // When runtime retries exhaust primary reliability, forceFallbackProvider switches cleanly to full SoundCloud track
        const fallbackDesc = await registry.getStreamDescriptor(ytTrack, {
            allowFallbackProvider: true,
            forceFallbackProvider: true,
        });
        expect(fallbackDesc.canonicalKey).toContain("soundcloud:");
        expect(fallbackDesc.url).toContain("cf-media.sndcdn.com/full.mp3");
    });

    it("retries YouTube with IPv4 on bot_detection and returns descriptor when IPv4 succeeds", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206 })),
        );

        const dumpCalls: Array<{ input: string; forceIpv4?: boolean; extractorArgs?: string }> = [];
        const ytdlpStub = {
            dumpJson: vi.fn(
                async (input: string, opts?: { forceIpv4?: boolean; extractorArgs?: string }) => {
                    dumpCalls.push({
                        input,
                        forceIpv4: opts?.forceIpv4,
                        extractorArgs: opts?.extractorArgs,
                    });
                    if (!opts?.forceIpv4) {
                        throw new ProviderError(
                            "YouTube requested bot-verification cookies",
                            "bot_detection",
                            false,
                        );
                    }
                    return {
                        id: "yt_ipv4_ok",
                        title: "La Tabtaad Arjouk",
                        duration: 301,
                        formats: [
                            {
                                format_id: "251",
                                url: "https://rr2.googlevideo.com/videoplayback?itag=251&ipv4=1",
                                acodec: "opus",
                                vcodec: "none",
                                abr: 132,
                                asr: 48000,
                                audio_channels: 2,
                                ext: "webm",
                                protocol: "https",
                            },
                        ],
                    };
                },
            ),
        } as unknown as YtDlpClient;

        const yt = new YouTubeProvider(ytdlpStub);
        const descriptor = await yt.getStreamDescriptor({
            id: "yt_ipv4_ok",
            title: "La Tabtaad Arjouk",
            url: "https://www.youtube.com/watch?v=yt_ipv4_ok",
            duration: 301,
            thumbnail: "",
            author: "Hagoula Khaleji - Topic",
            provider: "youtube",
        });

        expect(descriptor.url).toContain("ipv4=1");
        expect(dumpCalls).toHaveLength(2);
        expect(dumpCalls[0]?.forceIpv4).toBeUndefined();
        expect(dumpCalls[1]?.forceIpv4).toBe(true);
        expect(dumpCalls[1]?.extractorArgs).toBeUndefined();
    });

    it("falls back to SoundCloud full track when YouTube hits bot_detection and skips 30s Go+ previews", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes("sc-full.example/playlist.m3u8")) {
                    return new Response(
                        "#EXTM3U\n#EXTINF:5.0,\nhttps://sc-full.example/seg0.aac\n",
                        { status: 200 },
                    );
                }
                if (url.includes("sc-full.example/seg0.aac")) {
                    return new Response(new Uint8Array([9, 8, 7]), { status: 206 });
                }
                return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
            }),
        );

        const searchedQueries: string[] = [];
        const ytdlpStub = {
            dumpJson: vi.fn(
                async (input: string, _opts?: { forceIpv4?: boolean; extractorArgs?: string }) => {
                    if (input.includes("youtube.com")) {
                        throw new ProviderError(
                            "YouTube requested bot-verification cookies",
                            "bot_detection",
                            false,
                        );
                    }
                    if (input.startsWith("scsearch8:")) {
                        const query = input.slice("scsearch8:".length);
                        searchedQueries.push(query);
                        if (query.startsWith("Drake ")) {
                            // First "[author] [title]" query only returns a 30s Go+ preview
                            return {
                                entries: [
                                    {
                                        id: "sc_preview_only",
                                        title: "STFU Preview",
                                        webpage_url: "https://soundcloud.com/janicethis/stfu",
                                        duration: 30,
                                        uploader: "Janice",
                                    },
                                ],
                            };
                        }
                        // Second cleaned title-only query returns preview first, full track second
                        return {
                            entries: [
                                {
                                    id: "sc_preview_first",
                                    title: "Janice STFU (Go+ Preview)",
                                    webpage_url: "https://soundcloud.com/janicethis/stfu",
                                    duration: 30,
                                    uploader: "janicethis",
                                },
                                {
                                    id: "sc_full_track",
                                    title: "Janice STFU Full",
                                    webpage_url:
                                        "https://soundcloud.com/free-drake-songs/janice-stfu-drake-iceman",
                                    duration: 249.7,
                                    uploader: "Free Drake Songs",
                                },
                            ],
                        };
                    }
                    if (input.includes("janice-stfu-drake-iceman")) {
                        return {
                            id: "sc_full_track",
                            title: "Janice STFU Full",
                            duration: 249.7,
                            formats: [
                                {
                                    format_id: "hls_mp3_1_0_preview",
                                    url: "https://sc-preview.example/preview.m3u8",
                                    acodec: "mp3",
                                    vcodec: "none",
                                    abr: 128,
                                    ext: "mp3",
                                    protocol: "m3u8_native",
                                },
                                {
                                    format_id: "hls_aac_96k",
                                    url: "https://sc-full.example/playlist.m3u8",
                                    acodec: "aac",
                                    vcodec: "none",
                                    abr: 96,
                                    ext: "m4a",
                                    protocol: "m3u8_native",
                                },
                            ],
                        };
                    }
                    throw new Error(`Unexpected dumpJson input: ${input}`);
                },
            ),
        } as unknown as YtDlpClient;

        const registry = new ProviderRegistry({ ytdlp: ytdlpStub });
        const descriptor = await registry.getStreamDescriptor({
            id: "yt_bot_1",
            title: "Janice STFU (Official Audio)",
            url: "https://www.youtube.com/watch?v=yt_bot_1",
            duration: 238,
            thumbnail: "",
            author: "Drake - Topic",
            provider: "youtube",
        });

        expect(searchedQueries).toEqual(["Drake Janice STFU", "Janice STFU"]);
        expect(descriptor.canonicalKey).toBe("soundcloud:sc_full_track");
        expect(descriptor.url).toContain("sc-full.example/playlist.m3u8");
    });

    it("reuses resolved YouTube entry formats in getStreamDescriptor without spawning yt-dlp twice", async () => {
        let cachedUrlExpired = false;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes("cached_v1") && cachedUrlExpired) {
                    return new Response("", { status: 403 });
                }
                return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
            }),
        );

        let dumpCalls = 0;
        const ytdlpStub = {
            dumpJson: vi.fn(async () => {
                dumpCalls += 1;
                const ver = dumpCalls === 1 ? "cached_v1" : "fresh_v2";
                return {
                    id: "dQw4w9WgXcQ",
                    title: "Single-Pass Track",
                    webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
                    duration: 212,
                    uploader: "Artist",
                    formats: [
                        {
                            format_id: "251",
                            url: `https://rr1.googlevideo.com/videoplayback?itag=251&ver=${ver}`,
                            acodec: "opus",
                            vcodec: "none",
                            abr: 130,
                            asr: 48000,
                            audio_channels: 2,
                            ext: "webm",
                            protocol: "https",
                        },
                    ],
                };
            }),
        } as unknown as YtDlpClient;

        const yt = new YouTubeProvider(ytdlpStub);
        const resolved = await yt.resolveUrl(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "track",
        );
        expect(resolved.items).toHaveLength(1);
        expect(dumpCalls).toBe(1);

        // First stream resolution reuses cached entry — zero second yt-dlp invocation
        const track = resolved.items[0];
        expect(track).toBeDefined();
        if (!track) {
            throw new Error("Expected resolved track");
        }
        const firstDesc = await yt.getStreamDescriptor(track);
        expect(firstDesc.url).toContain("ver=cached_v1");
        expect(firstDesc.directPassthroughEligible).toBe(true);
        expect(dumpCalls).toBe(1);

        // If the cached format URL later 403s, stale entry is evicted and refreshed seamlessly
        cachedUrlExpired = true;
        const refreshedDesc = await yt.getStreamDescriptor(track);
        expect(refreshedDesc.url).toContain("ver=fresh_v2");
        expect(dumpCalls).toBe(2);
    });

    it("ranks original studio tracks above remixes, slowed/reverb, covers, and knock-offs unless explicitly requested", () => {
        const candidates = [
            {
                id: "remix_1",
                title: "Solar Eclipse (DJ Club Remix)",
                url: "https://www.youtube.com/watch?v=remix_1",
                duration: 219,
                thumbnail: "",
                author: "Random DJ",
                provider: "youtube" as const,
            },
            {
                id: "slowed_1",
                title: "Solar Eclipse (Slowed + Reverb)",
                url: "https://www.youtube.com/watch?v=slowed_1",
                duration: 260,
                thumbnail: "",
                author: "Aesthetic Edits",
                provider: "youtube" as const,
            },
            {
                id: "cover_1",
                title: "Solar Eclipse",
                url: "https://www.youtube.com/watch?v=cover_1",
                duration: 219,
                thumbnail: "",
                author: "Tribute Karaoke Band",
                provider: "youtube" as const,
            },
            {
                id: "orig_1",
                title: "Solar Eclipse (Official Audio)",
                url: "https://www.youtube.com/watch?v=orig_1",
                duration: 219,
                thumbnail: "",
                author: "Drake - Topic",
                provider: "youtubemusic" as const,
            },
        ];

        const bestOriginal = selectBestMatchingTrack(candidates, {
            query: "Drake & Don Toliver - Solar Eclipse",
            targetTitle: "Solar Eclipse",
            targetArtists: ["Drake", "Don Toliver"],
            targetDurationSeconds: 219,
        });
        expect(bestOriginal?.id).toBe("orig_1");

        // When user explicitly asks for slowed + reverb, the slowed version wins
        const bestSlowed = selectBestMatchingTrack(candidates, {
            query: "Solar Eclipse slowed reverb",
        });
        expect(bestSlowed?.id).toBe("slowed_1");

        // When user explicitly asks for remix, the remix wins
        const rankedRemix = rankTrackCandidates(candidates, {
            query: "Solar Eclipse DJ Club Remix",
        });
        expect(rankedRemix[0]?.track.id).toBe("remix_1");
    });

    it("parses artist names accurately from YouTube Music InnerTube runs and skips media type badges like Song/Video", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                return new Response(
                    JSON.stringify({
                        contents: {
                            sectionListRenderer: {
                                contents: [
                                    {
                                        musicShelfRenderer: {
                                            contents: [
                                                {
                                                    musicResponsiveListItemRenderer: {
                                                        playlistItemData: {
                                                            videoId: "vid_knockoff",
                                                        },
                                                        flexColumns: [
                                                            {
                                                                musicResponsiveListItemFlexColumnRenderer:
                                                                    {
                                                                        text: {
                                                                            runs: [
                                                                                {
                                                                                    text: "Blinding Lights (8-Bit Tribute Remix)",
                                                                                },
                                                                            ],
                                                                        },
                                                                    },
                                                            },
                                                            {
                                                                musicResponsiveListItemFlexColumnRenderer:
                                                                    {
                                                                        text: {
                                                                            runs: [
                                                                                { text: "Song" },
                                                                                { text: " • " },
                                                                                {
                                                                                    text: "8-Bit Arcade",
                                                                                },
                                                                                { text: " • " },
                                                                                { text: "3:20" },
                                                                            ],
                                                                        },
                                                                    },
                                                            },
                                                        ],
                                                    },
                                                },
                                                {
                                                    musicResponsiveListItemRenderer: {
                                                        playlistItemData: {
                                                            videoId: "vid_orig111",
                                                        },
                                                        flexColumns: [
                                                            {
                                                                musicResponsiveListItemFlexColumnRenderer:
                                                                    {
                                                                        text: {
                                                                            runs: [
                                                                                {
                                                                                    text: "Blinding Lights",
                                                                                },
                                                                            ],
                                                                        },
                                                                    },
                                                            },
                                                            {
                                                                musicResponsiveListItemFlexColumnRenderer:
                                                                    {
                                                                        text: {
                                                                            runs: [
                                                                                { text: "Song" },
                                                                                { text: " • " },
                                                                                {
                                                                                    text: "The Weeknd",
                                                                                    navigationEndpoint:
                                                                                        {
                                                                                            browseEndpoint:
                                                                                                {
                                                                                                    browseEndpointContextSupportedConfigs:
                                                                                                        {
                                                                                                            browseEndpointContextMusicConfig:
                                                                                                                {
                                                                                                                    pageType:
                                                                                                                        "MUSIC_PAGE_TYPE_ARTIST",
                                                                                                                },
                                                                                                        },
                                                                                                },
                                                                                        },
                                                                                },
                                                                                { text: " • " },
                                                                                {
                                                                                    text: "After Hours",
                                                                                },
                                                                                { text: " • " },
                                                                                { text: "3:20" },
                                                                            ],
                                                                        },
                                                                    },
                                                            },
                                                        ],
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                    }),
                    { status: 200 },
                );
            }),
        );

        const tracks = await searchYouTubeMusicInnerTube("The Weeknd Blinding Lights", 1);
        expect(tracks).toHaveLength(1);
        expect(tracks[0]?.id).toBe("vid_orig111");
        expect(tracks[0]?.author).toBe("The Weeknd");
        expect(tracks[0]?.duration).toBe(200);
    });

    it("prefers original full track over top-ranked SoundCloud remix during fallback and fast-fails repeated YouTube bot blocks", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 206 })),
        );

        let ytDumpCount = 0;
        const ytdlpStub = {
            dumpJson: vi.fn(async (input: string) => {
                if (input.includes("youtube.com")) {
                    ytDumpCount += 1;
                    throw new ProviderError(
                        "YouTube requested bot-verification cookies",
                        "bot_detection",
                        false,
                    );
                }
                if (input.startsWith("scsearch")) {
                    return {
                        entries: [
                            {
                                id: "sc_remix",
                                title: "Solar Eclipse (Slowed + Reverb TikTok Remix)",
                                webpage_url: "https://soundcloud.com/random/solar-eclipse-remix",
                                duration: 220,
                                uploader: "Random Edits",
                            },
                            {
                                id: "sc_original",
                                title: "Drake & Don Toliver - Solar Eclipse",
                                webpage_url: "https://soundcloud.com/drake/solar-eclipse",
                                duration: 219,
                                uploader: "Drake",
                            },
                        ],
                    };
                }
                if (input.includes("soundcloud.com/drake/solar-eclipse")) {
                    return {
                        id: "sc_original",
                        title: "Drake & Don Toliver - Solar Eclipse",
                        duration: 219,
                        formats: [
                            {
                                format_id: "http_mp3_128",
                                url: "https://cf-media.sndcdn.com/solar-eclipse-orig.mp3",
                                acodec: "mp3",
                                vcodec: "none",
                                abr: 128,
                                ext: "mp3",
                                protocol: "https",
                            },
                        ],
                    };
                }
                throw new Error(`Unexpected dumpJson input: ${input}`);
            }),
        } as unknown as YtDlpClient;

        const registry = new ProviderRegistry({ ytdlp: ytdlpStub });
        const track = {
            id: "yt_solar_1",
            title: "Solar Eclipse",
            url: "https://www.youtube.com/watch?v=yt_solar_1",
            duration: 219,
            thumbnail: "",
            author: "Drake & Don Toliver",
            provider: "youtube" as const,
        };

        const desc1 = await registry.getStreamDescriptor(track);
        expect(desc1.canonicalKey).toBe("soundcloud:sc_original");
        expect(desc1.url).toContain("solar-eclipse-orig.mp3");
        const firstTrackYtCalls = ytDumpCount;
        expect(firstTrackYtCalls).toBeGreaterThan(0);

        // Second track during active bot-detection cooldown skips dead YouTube spawns immediately (0 extra yt-dlp calls)
        const desc2 = await registry.getStreamDescriptor({
            ...track,
            id: "yt_solar_2",
            url: "https://www.youtube.com/watch?v=yt_solar_2",
        });
        expect(desc2.canonicalKey).toBe("soundcloud:sc_original");
        expect(ytDumpCount).toBe(firstTrackYtCalls);
    });

    it("resolves YouTube stream via direct mobile InnerTube player in one pass without spawning yt-dlp and ranks free-form queries accurately", async () => {
        // 1. Free-form query ("Solar Eclipse Drake Don Toliver") ranks studio track above podcast review episode
        const freeFormCandidates = [
            {
                id: "3wKKVIGoHWc",
                title: "Drake, Don Toliver – “Solar Eclipse” (LET’S TALK ABOUT IT: MUSIX REVIEWS)",
                url: "https://music.youtube.com/watch?v=3wKKVIGoHWc",
                duration: 0,
                thumbnail: "",
                author: "Oct 2",
                provider: "youtubemusic" as const,
            },
            {
                id: "eJFi2TK5174",
                title: "Solar Eclipse",
                url: "https://music.youtube.com/watch?v=eJFi2TK5174",
                duration: 219,
                thumbnail: "",
                author: "Drake & Don Toliver",
                provider: "youtubemusic" as const,
            },
        ];

        const bestFreeForm = selectBestMatchingTrack(freeFormCandidates, {
            query: "Solar Eclipse Drake Don Toliver",
        });
        expect(bestFreeForm?.id).toBe("eJFi2TK5174");

        // 2. Direct VISIONOS InnerTube player resolves itag=251 WebM/Opus with 0 yt-dlp calls and 0 googlevideo probe RTTs
        let googlevideoProbes = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (input: string | URL) => {
                const url = String(input);
                if (url.includes("googlevideo.com")) {
                    googlevideoProbes += 1;
                }
                if (url.includes("sw.js_data")) {
                    return new Response(
                        ')]}\'\n["Cgt2aXNpdG9yRGF0YV90b2tlbl9leGFtcGxlX2FiY2RlZg%3D%3D"]',
                        {
                            status: 200,
                        },
                    );
                }
                if (url.includes("youtubei/v1/player")) {
                    return new Response(
                        JSON.stringify({
                            playabilityStatus: { status: "OK" },
                            videoDetails: {
                                videoId: "eJFi2TK5174",
                                title: "Solar Eclipse",
                                author: "Drake - Topic",
                                lengthSeconds: "219",
                            },
                            streamingData: {
                                adaptiveFormats: [
                                    {
                                        itag: 251,
                                        url: "https://rr1---sn.googlevideo.com/videoplayback?itag=251&id=eJFi2TK5174",
                                        mimeType: 'audio/webm; codecs="opus"',
                                        bitrate: 135000,
                                        averageBitrate: 132000,
                                        audioSampleRate: "48000",
                                        audioChannels: 2,
                                    },
                                ],
                            },
                        }),
                        { status: 200 },
                    );
                }
                return new Response(new Uint8Array([1, 2, 3]), { status: 206 });
            }),
        );

        let dumpCalls = 0;
        const ytdlpStub = {
            dumpJson: vi.fn(async () => {
                dumpCalls += 1;
                throw new Error(
                    "yt-dlp should not be spawned when InnerTube mobile player succeeds",
                );
            }),
        } as unknown as YtDlpClient;

        const yt = new YouTubeProvider(ytdlpStub);
        const descriptor = await yt.getStreamDescriptor({
            id: "eJFi2TK5174",
            title: "Solar Eclipse",
            url: "https://music.youtube.com/watch?v=eJFi2TK5174",
            playableUrl: "https://www.youtube.com/watch?v=eJFi2TK5174",
            duration: 219,
            thumbnail: "",
            author: "Drake & Don Toliver",
            provider: "youtubemusic",
        });

        expect(dumpCalls).toBe(0);
        expect(googlevideoProbes).toBe(0);
        expect(descriptor.directPassthroughEligible).toBe(true);
        expect(descriptor.codec).toBe("opus");
        expect(descriptor.container).toBe("webm");
        expect(descriptor.url).toContain("itag=251");
    });

    it("extracts visitorData across all base64 padding lengths and rejects SoundCloud knock-off flips/versions/edits", () => {
        // 1. sw.js_data visitorData extraction with 0, 1 (%3D), and 2 (%3D%3D) padding bytes
        const swPayloadSinglePad = `)]}'\n[[["www.youtube.com/sw.js",null],["i"],["131.0.0.0",0,[[0,0,0,0,"",0,"","","https://www.youtube.com",0,0,"","US","CgsxMjM0NTY3ODkwYSDGpOjXBjIKCgJERRIEGgAgWw%3D","",82,"Mozilla/5.0","COSR6NcGEIaR6NcGGM6V6NcGGPCV6NcGGKGW6NcG%3D%3D"]]]]]`;
        expect(extractVisitorDataFromSwJsData(swPayloadSinglePad)).toBe(
            "CgsxMjM0NTY3ODkwYSDGpOjXBjIKCgJERRIEGgAgWw%3D",
        );

        const swPayloadNoPad = `)]}'\n[[["www.youtube.com/sw.js",null],["i"],["131.0.0.0",0,[[0,0,0,0,"",0,"","","https://www.youtube.com",0,0,"","US","CgtFiUVmR2hJaktsTW5PcFFyU3RVdlh5Wg","",82,"Mozilla/5.0","COSR6NcGEIaR6NcGGM6V6NcGGPCV6NcGGKGW6NcG%3D%3D"]]]]]`;
        expect(extractVisitorDataFromSwJsData(swPayloadNoPad)).toBe(
            "CgtFiUVmR2hJaktsTW5PcFFyU3RVdlh5Wg",
        );

        // 2. Rejects SoundCloud knock-off flips/versions/edits even when URL slug contains target artist
        const matchContext = {
            query: "Drake & Don Toliver - Solar Eclipse",
            targetTitle: "Solar Eclipse",
            targetAuthor: "Drake & Don Toliver",
            targetDurationSeconds: 219,
        };
        const scKnockoffs = [
            {
                id: "sc1",
                title: "Drake & Don Toliver - Solar Eclipse v2 [MadeByMatty Version]",
                url: "https://soundcloud.com/madebymattyofficial/drake-choosin-texas-v2-ft-don",
                duration: 239,
                thumbnail: "",
                author: "itsMadeByMatty",
                provider: "soundcloud" as const,
            },
            {
                id: "sc2",
                title: "Solar Eclipse (Drake & Don Toliver - Choosin' Texas) [MOJë Flip]",
                url: "https://soundcloud.com/itsmoje/solar-eclipse",
                duration: 211,
                thumbnail: "",
                author: "MOJë",
                provider: "soundcloud" as const,
            },
            {
                id: "sc3",
                title: "solar eclipse (ftp afro house edit)",
                url: "https://soundcloud.com/fromtheprojects/solar-eclipse-ftp-afro-house",
                duration: 232,
                thumbnail: "",
                author: "FTP",
                provider: "soundcloud" as const,
            },
            {
                id: "sc4",
                title: "Drake, Don Toliver - Solar Eclipse ( Mwon Version )",
                url: "https://soundcloud.com/mwonmusic/drake-don-toliver-solar",
                duration: 253,
                thumbnail: "",
                author: "MWON",
                provider: "soundcloud" as const,
            },
        ];

        const ranked = rankTrackCandidates(scKnockoffs, matchContext);
        for (const entry of ranked) {
            expect(hasUnrequestedVariant(entry.track, matchContext)).toBe(true);
            expect(entry.score).toBeLessThan(0);
        }
    });
});
