import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Innertube, Log, Platform } from "youtubei.js";
import type { YtDlpEntry, YtDlpFormatEntry } from "./YtDlpClient.js";

// Silence youtubei.js parser introspection logs in production stdout
Log.setLevel(Log.Level.NONE);

let shimConfigured = false;
function ensureYouTubeJsPlatformShim(): void {
    if (shimConfigured) return;
    shimConfigured = true;
    Platform.shim.eval = async (
        data: { output: string },
        env: Record<string, unknown>,
    ): Promise<unknown> => {
        const props: string[] = [];
        if (typeof env.n === "string") {
            props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
        }
        if (typeof env.sig === "string") {
            props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
        }
        const code = `${data.output}\nreturn { ${props.join(", ")} };`;
        // YouTube's player.js signature/n-token transform functions are pure arithmetic/string shuffles
        return new Function(code)();
    };
}

// Official YouTube TV HTML5 OAuth2 client credentials (same public device-flow client used by Lavalink youtube-source)
const YT_TV_OAUTH_CLIENT_ID =
    "861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com";
const YT_TV_OAUTH_CLIENT_SECRET = "SboVhoG9s0rNafixCSGGKXAT";
const YT_TV_OAUTH_SCOPES = "http://gdata.youtube.com https://www.googleapis.com/auth/youtube";
const YT_DEVICE_CODE_URL = "https://www.youtube.com/o/oauth2/device/code";
const YT_TOKEN_URL = "https://www.youtube.com/o/oauth2/token";
const TV_PS4_USER_AGENT =
    "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";
const WEB_CHROME_USER_AGENT =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface StoredYouTubeOAuthData {
    refreshToken: string;
    accessToken?: string;
    expiresAt?: number;
    updatedAt: number;
}

export interface YouTubeDeviceCodeSession {
    verificationUrl: string;
    userCode: string;
    deviceCode: string;
    expiresIn: number;
    intervalSeconds: number;
}

export class YouTubeOAuthManager {
    private readonly tokenFilePath: string | null;
    private refreshToken: string | null;
    private accessToken: string | null = null;
    private accessTokenExpiresAt = 0;
    private inflightRefresh: Promise<string | null> | null = null;
    private pollAbortController: AbortController | null = null;

    public constructor(options?: { dataDir?: string | null; initialRefreshToken?: string | null }) {
        this.tokenFilePath = options?.dataDir ? join(options.dataDir, "youtube-oauth.json") : null;
        this.refreshToken = options?.initialRefreshToken?.trim() || null;

        if (!this.refreshToken && this.tokenFilePath && existsSync(this.tokenFilePath)) {
            try {
                const raw = JSON.parse(
                    readFileSync(this.tokenFilePath, "utf8"),
                ) as Partial<StoredYouTubeOAuthData>;
                if (typeof raw.refreshToken === "string" && raw.refreshToken.trim()) {
                    this.refreshToken = raw.refreshToken.trim();
                    if (
                        typeof raw.accessToken === "string" &&
                        typeof raw.expiresAt === "number" &&
                        raw.expiresAt > Date.now() + 60_000
                    ) {
                        this.accessToken = raw.accessToken;
                        this.accessTokenExpiresAt = raw.expiresAt;
                    }
                }
            } catch {
                // Ignore corrupted file
            }
        }
    }

    public hasRefreshToken(): boolean {
        return Boolean(this.refreshToken);
    }

    public getRefreshToken(): string | null {
        return this.refreshToken;
    }

    public setRefreshToken(token: string | null): void {
        const cleaned = token?.trim() || null;
        this.refreshToken = cleaned;
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        if (!cleaned) {
            this.clear();
            return;
        }
        this.persist({
            refreshToken: cleaned,
            updatedAt: Date.now(),
        });
    }

    public clear(): void {
        if (this.pollAbortController) {
            this.pollAbortController.abort();
            this.pollAbortController = null;
        }
        this.refreshToken = null;
        this.accessToken = null;
        this.accessTokenExpiresAt = 0;
        if (this.tokenFilePath && existsSync(this.tokenFilePath)) {
            try {
                unlinkSync(this.tokenFilePath);
            } catch {
                // Ignore unlink errors
            }
        }
    }

    private persist(data: StoredYouTubeOAuthData): void {
        if (!this.tokenFilePath) return;
        try {
            mkdirSync(dirname(this.tokenFilePath), { recursive: true });
            writeFileSync(this.tokenFilePath, JSON.stringify(data, null, 2), {
                encoding: "utf8",
                mode: 0o600,
            });
        } catch {
            // Non-fatal in read-only test dirs
        }
    }

    public async startDeviceFlow(options?: {
        onAuthorized?: (refreshToken: string) => Promise<void> | void;
        onError?: (err: Error) => Promise<void> | void;
    }): Promise<YouTubeDeviceCodeSession> {
        if (this.pollAbortController) {
            this.pollAbortController.abort();
        }

        const res = await fetch(YT_DEVICE_CODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: YT_TV_OAUTH_CLIENT_ID,
                scope: YT_TV_OAUTH_SCOPES,
                device_id: randomUUID().replace(/-/gu, ""),
                device_model: "ytlr::",
            }),
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
            throw new Error(`YouTube OAuth2 device code request failed (HTTP ${res.status})`);
        }

        const payload = (await res.json()) as {
            device_code?: string;
            user_code?: string;
            verification_url?: string;
            expires_in?: number;
            interval?: number;
        };

        if (!payload.device_code || !payload.user_code || !payload.verification_url) {
            throw new Error("Invalid device code payload returned by YouTube OAuth2");
        }

        const session: YouTubeDeviceCodeSession = {
            verificationUrl: payload.verification_url,
            userCode: payload.user_code,
            deviceCode: payload.device_code,
            expiresIn: payload.expires_in ?? 1800,
            intervalSeconds: Math.max(payload.interval ?? 5, 5),
        };

        const controller = new AbortController();
        this.pollAbortController = controller;

        void this.pollDeviceAuthorization(session, controller.signal, options);
        return session;
    }

    private async pollDeviceAuthorization(
        session: YouTubeDeviceCodeSession,
        signal: AbortSignal,
        callbacks?: {
            onAuthorized?: (refreshToken: string) => Promise<void> | void;
            onError?: (err: Error) => Promise<void> | void;
        },
    ): Promise<void> {
        const deadline = Date.now() + session.expiresIn * 1000;
        let intervalMs = session.intervalSeconds * 1000;

        while (!signal.aborted && Date.now() < deadline) {
            await new Promise((resolve) => {
                const t = setTimeout(resolve, intervalMs);
                t.unref?.();
            });
            if (signal.aborted) return;

            try {
                const res = await fetch(YT_TOKEN_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: YT_TV_OAUTH_CLIENT_ID,
                        client_secret: YT_TV_OAUTH_CLIENT_SECRET,
                        code: session.deviceCode,
                        grant_type: "http://oauth.net/grant_type/device/1.0",
                    }),
                    signal,
                });

                const data = (await res.json()) as {
                    access_token?: string;
                    refresh_token?: string;
                    expires_in?: number;
                    error?: string;
                };

                if (data.error) {
                    if (data.error === "authorization_pending") continue;
                    if (data.error === "slow_down") {
                        intervalMs += 2_000;
                        continue;
                    }
                    throw new Error(`YouTube OAuth2 failed: ${data.error}`);
                }

                if (data.refresh_token && data.access_token) {
                    const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
                    this.refreshToken = data.refresh_token;
                    this.accessToken = data.access_token;
                    this.accessTokenExpiresAt = expiresAt;
                    this.persist({
                        refreshToken: data.refresh_token,
                        accessToken: data.access_token,
                        expiresAt,
                        updatedAt: Date.now(),
                    });
                    await callbacks?.onAuthorized?.(data.refresh_token);
                    return;
                }
            } catch (err) {
                if (signal.aborted) return;
                await callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)));
                return;
            }
        }
    }

    public async getValidAccessToken(signal?: AbortSignal): Promise<string | null> {
        if (!this.refreshToken) return null;
        if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
            return this.accessToken;
        }
        if (this.inflightRefresh) {
            return this.inflightRefresh;
        }

        this.inflightRefresh = (async () => {
            try {
                const res = await fetch(YT_TOKEN_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: YT_TV_OAUTH_CLIENT_ID,
                        client_secret: YT_TV_OAUTH_CLIENT_SECRET,
                        refresh_token: this.refreshToken,
                        grant_type: "refresh_token",
                    }),
                    signal: signal ?? AbortSignal.timeout(8_000),
                });
                if (!res.ok) return null;
                const data = (await res.json()) as {
                    access_token?: string;
                    refresh_token?: string;
                    expires_in?: number;
                    error?: string;
                };
                if (data.error || !data.access_token) return null;

                const nextRefresh = data.refresh_token || this.refreshToken;
                const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
                this.accessToken = data.access_token;
                this.accessTokenExpiresAt = expiresAt;
                if (nextRefresh) {
                    this.refreshToken = nextRefresh;
                    this.persist({
                        refreshToken: nextRefresh,
                        accessToken: data.access_token,
                        expiresAt,
                        updatedAt: Date.now(),
                    });
                }
                return this.accessToken;
            } catch {
                return null;
            }
        })().finally(() => {
            this.inflightRefresh = null;
        });

        return this.inflightRefresh;
    }
}

let cachedAnonInnertube: Promise<Innertube | null> | null = null;
let cachedCookieInnertube: { cookie: string; promise: Promise<Innertube | null> } | null = null;

function isMockedFetchEnvironment(): boolean {
    return typeof (globalThis.fetch as unknown as { mock?: unknown })?.mock !== "undefined";
}

async function getAnonInnertube(): Promise<Innertube | null> {
    if (!cachedAnonInnertube) {
        ensureYouTubeJsPlatformShim();
        cachedAnonInnertube = Innertube.create({
            retrieve_player: true,
            generate_session_locally: true,
        }).catch(() => {
            cachedAnonInnertube = null;
            return null;
        });
    }
    return cachedAnonInnertube;
}

async function getCookieInnertube(cookie: string): Promise<Innertube | null> {
    if (cachedCookieInnertube?.cookie === cookie) {
        return cachedCookieInnertube.promise;
    }
    ensureYouTubeJsPlatformShim();
    const promise = Innertube.create({
        cookie,
        retrieve_player: true,
    }).catch(() => null);
    cachedCookieInnertube = { cookie, promise };
    return promise;
}

/**
 * Resolves and deciphers signatureCipher / n-param streams in ~300ms directly in Node.js
 * using youtubei.js's cached JS player (supports OAuth2 Bearer tokens, cookies, and YTMUSIC).
 */
export async function resolveYouTubeCipheredStream(
    videoId: string,
    options: {
        oauthManager?: YouTubeOAuthManager | null;
        cookieHeader?: string | null;
        signal?: AbortSignal;
    } = {},
): Promise<{ entry: YtDlpEntry | null; botDetected: boolean }> {
    if (!videoId || options.signal?.aborted || isMockedFetchEnvironment()) {
        return { entry: null, botDetected: false };
    }

    let botDetected = false;

    // 1. OAuth2 TVHTML5 / InnerTube with local player.js deciphering
    const accessToken = await options.oauthManager?.getValidAccessToken(options.signal);
    if (accessToken && !options.signal?.aborted) {
        const yt = await getAnonInnertube();
        if (yt?.session.player) {
            const oauthRes = await fetchTvPlayerWithOAuth(videoId, accessToken, yt, options.signal);
            if (oauthRes.entry) {
                return oauthRes;
            }
            if (oauthRes.botDetected) {
                botDetected = true;
            }
        }
    }

    // 2. Cookie-authenticated YTMUSIC / WEB with local player.js deciphering
    if (options.cookieHeader && !options.signal?.aborted) {
        const cookieYt = await getCookieInnertube(options.cookieHeader);
        if (cookieYt) {
            for (const client of ["YTMUSIC", "WEB"] as const) {
                if (options.signal?.aborted) break;
                const res = await extractFromInnertubeInstance(
                    cookieYt,
                    videoId,
                    client,
                    WEB_CHROME_USER_AGENT,
                );
                if (res.entry) return res;
                if (res.botDetected) botDetected = true;
            }
        }
    }

    // 3. Unauthenticated YTMUSIC with local player.js deciphering (~350ms)
    if (!options.signal?.aborted) {
        const anonYt = await getAnonInnertube();
        if (anonYt) {
            const res = await extractFromInnertubeInstance(
                anonYt,
                videoId,
                "YTMUSIC",
                WEB_CHROME_USER_AGENT,
            );
            if (res.entry) return res;
            if (res.botDetected) botDetected = true;
        }
    }

    return { entry: null, botDetected };
}

async function fetchTvPlayerWithOAuth(
    videoId: string,
    accessToken: string,
    yt: Innertube,
    signal?: AbortSignal,
): Promise<{ entry: YtDlpEntry | null; botDetected: boolean }> {
    try {
        const res = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${accessToken}`,
                "User-Agent": TV_PS4_USER_AGENT,
                "X-YouTube-Client-Name": "7",
                "X-YouTube-Client-Version": "7.20250319.10.00",
                Origin: "https://www.youtube.com",
            },
            body: JSON.stringify({
                videoId,
                context: {
                    client: {
                        clientName: "TVHTML5",
                        clientVersion: "7.20250319.10.00",
                        hl: "en",
                        gl: "US",
                    },
                },
                playbackContext: {
                    contentPlaybackContext: {
                        signatureTimestamp: yt.session.player?.signature_timestamp,
                    },
                },
                contentCheckOk: true,
                racyCheckOk: true,
            }),
            signal: signal ?? AbortSignal.timeout(4_500),
        });
        if (!res.ok) return { entry: null, botDetected: false };
        const data = (await res.json()) as {
            playabilityStatus?: { status?: string; reason?: string };
            videoDetails?: {
                videoId?: string;
                title?: string;
                lengthSeconds?: string;
                author?: string;
                isLiveContent?: boolean;
            };
            streamingData?: {
                adaptiveFormats?: Array<{
                    itag?: number;
                    url?: string;
                    signatureCipher?: string;
                    cipher?: string;
                    mimeType?: string;
                    bitrate?: number;
                    averageBitrate?: number;
                    audioSampleRate?: string;
                    audioChannels?: number;
                }>;
            };
        };

        const status = data.playabilityStatus?.status ?? "";
        const reason = (data.playabilityStatus?.reason ?? "").toLowerCase();
        if (status !== "OK") {
            const isBot =
                status === "LOGIN_REQUIRED" &&
                (reason.includes("not a bot") || reason.includes("sign in"));
            return { entry: null, botDetected: isBot };
        }

        const formats: YtDlpFormatEntry[] = [];
        for (const f of data.streamingData?.adaptiveFormats ?? []) {
            if (!f.mimeType?.toLowerCase().startsWith("audio/")) continue;
            let resolvedUrl = f.url ?? null;
            if (yt.session.player && (f.url || f.signatureCipher || f.cipher)) {
                resolvedUrl = await yt.session.player.decipher(f.url, f.signatureCipher, f.cipher);
            }
            if (!resolvedUrl) continue;

            const isOpus = f.mimeType.toLowerCase().includes("opus");
            const bps = f.averageBitrate ?? f.bitrate ?? 0;
            formats.push({
                format_id: f.itag !== undefined ? String(f.itag) : undefined,
                url: resolvedUrl,
                ext: isOpus ? "webm" : "m4a",
                protocol: "https",
                acodec: isOpus ? "opus" : "mp4a.40.2",
                vcodec: "none",
                asr: f.audioSampleRate ? Number.parseInt(f.audioSampleRate, 10) : undefined,
                audio_channels: f.audioChannels ?? 2,
                abr: bps > 0 ? Math.round(bps / 1000) : undefined,
                http_headers: { "User-Agent": TV_PS4_USER_AGENT },
            });
        }

        if (formats.length === 0) return { entry: null, botDetected: false };
        const dur = Number.parseInt(data.videoDetails?.lengthSeconds ?? "0", 10) || 0;
        return {
            entry: {
                id: data.videoDetails?.videoId ?? videoId,
                title: data.videoDetails?.title,
                webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
                duration: dur > 0 ? dur : undefined,
                artist: data.videoDetails?.author,
                uploader: data.videoDetails?.author,
                is_live: data.videoDetails?.isLiveContent === true,
                extractor: "youtube:oauth:tvhtml5",
                formats,
                http_headers: { "User-Agent": TV_PS4_USER_AGENT },
            },
            botDetected: false,
        };
    } catch {
        return { entry: null, botDetected: false };
    }
}

async function extractFromInnertubeInstance(
    yt: Innertube,
    videoId: string,
    client: "YTMUSIC" | "WEB",
    userAgent: string,
): Promise<{ entry: YtDlpEntry | null; botDetected: boolean }> {
    try {
        const info = await yt.getBasicInfo(videoId, { client });
        const status = info.playability_status?.status ?? "";
        const reason = (info.playability_status?.reason ?? "").toLowerCase();
        if (status !== "OK") {
            const isBot =
                status === "LOGIN_REQUIRED" &&
                (reason.includes("not a bot") || reason.includes("sign in"));
            return { entry: null, botDetected: isBot };
        }

        const adaptive = info.streaming_data?.adaptive_formats ?? [];
        const formats: YtDlpFormatEntry[] = [];
        for (const fmt of adaptive) {
            const mime = (fmt.mime_type ?? "").toLowerCase();
            if (!mime.startsWith("audio/")) continue;
            let url: string | undefined;
            try {
                url = await fmt.decipher(yt.session.player);
            } catch {
                url = fmt.url;
            }
            if (!url) continue;

            const isOpus = mime.includes("opus");
            const bps = fmt.average_bitrate ?? fmt.bitrate ?? 0;
            formats.push({
                format_id: fmt.itag !== undefined ? String(fmt.itag) : undefined,
                url,
                ext: isOpus ? "webm" : "m4a",
                protocol: "https",
                acodec: isOpus ? "opus" : "mp4a.40.2",
                vcodec: "none",
                asr: fmt.audio_sample_rate ?? (isOpus ? 48_000 : 44_100),
                audio_channels: fmt.audio_channels ?? 2,
                abr: bps > 0 ? Math.round(bps / 1000) : undefined,
                http_headers: { "User-Agent": userAgent },
            });
        }

        if (formats.length === 0) {
            return { entry: null, botDetected: false };
        }

        return {
            entry: {
                id: info.basic_info.id ?? videoId,
                title: info.basic_info.title,
                webpage_url: `https://www.youtube.com/watch?v=${videoId}`,
                duration: info.basic_info.duration,
                artist: info.basic_info.author,
                uploader: info.basic_info.author,
                is_live: info.basic_info.is_live === true,
                extractor: `youtube:ytjs:${client.toLowerCase()}`,
                formats,
                http_headers: { "User-Agent": userAgent },
            },
            botDetected: false,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        return {
            entry: null,
            botDetected: msg.includes("not a bot") || msg.includes("login_required"),
        };
    }
}
