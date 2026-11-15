import { type ChildProcess, spawn } from "node:child_process";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { type Logger, ProviderError, RateLimitError } from "@rawon/shared";

export interface YtDlpFormatEntry {
    format_id?: string;
    format_note?: string;
    url?: string;
    ext?: string;
    protocol?: string;
    acodec?: string;
    vcodec?: string;
    asr?: number;
    audio_channels?: number;
    abr?: number;
    tbr?: number;
    http_headers?: Record<string, string>;
}

export interface YtDlpEntry {
    id?: string;
    title?: string;
    fulltitle?: string;
    url?: string;
    webpage_url?: string;
    original_url?: string;
    duration?: number | null;
    thumbnail?: string;
    thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
    uploader?: string;
    channel?: string;
    artist?: string;
    creator?: string;
    is_live?: boolean;
    live_status?: string;
    _type?: string;
    entries?: Array<YtDlpEntry | null> | null;
    playlist_title?: string;
    playlist?: string;
    ext?: string;
    acodec?: string;
    vcodec?: string;
    asr?: number;
    audio_channels?: number;
    abr?: number;
    http_headers?: Record<string, string>;
    requested_formats?: YtDlpFormatEntry[];
    formats?: YtDlpFormatEntry[];
}

export interface YtDlpDumpOptions {
    flatPlaylist?: boolean;
    noPlaylist?: boolean;
    yesPlaylist?: boolean;
    playlistEnd?: number;
    playlistStart?: number;
    format?: string;
    extractorArgs?: string;
    forceIpv4?: boolean;
    skipCookies?: boolean;
    ignoreErrors?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
}

export interface YtDlpClientOptions {
    binaryPath?: string | null;
    cacheDir: string;
    cookiesPath?: string | null;
    visitorData?: string | null;
    forceIpv4?: boolean;
    logger?: Logger;
}

export function classifyYtDlpError(stderr: string): ProviderError | RateLimitError {
    const lower = stderr.toLowerCase();
    if (
        lower.includes("sign in to confirm you’re not a bot") ||
        lower.includes("sign in to confirm you're not a bot") ||
        lower.includes("confirm you are not a bot")
    ) {
        return new ProviderError(
            "YouTube requested bot-verification cookies",
            "bot_detection",
            false,
            new Error(stderr),
        );
    }
    if (lower.includes("sign in to confirm your age") || lower.includes("age-restricted")) {
        return new ProviderError(
            "Track is age-restricted and requires authenticated cookies",
            "age_restricted",
            false,
            new Error(stderr),
        );
    }
    if (lower.includes("429") || lower.includes("too many requests")) {
        return new RateLimitError("Provider rate-limited request (HTTP 429)", 5_000);
    }
    if (
        lower.includes("video unavailable") ||
        lower.includes("private video") ||
        lower.includes("this video has been removed") ||
        lower.includes("copyright")
    ) {
        return new ProviderError(
            "Track is unavailable or private",
            "unavailable",
            false,
            new Error(stderr),
        );
    }
    return new ProviderError(
        stderr.trim() || "yt-dlp failed without output",
        "network",
        true,
        new Error(stderr),
    );
}

export class ResolvedEntryCache {
    private readonly entries = new Map<string, { entry: YtDlpEntry; expiresAt: number }>();

    public constructor(
        private readonly maxEntries = 64,
        private readonly ttlMs = 120_000,
    ) {}

    public store(keys: readonly (string | undefined)[], entry: YtDlpEntry): void {
        if (!Array.isArray(entry.formats) || entry.formats.length === 0) {
            return;
        }
        const expiresAt = Date.now() + this.ttlMs;
        for (const rawKey of keys) {
            const key = rawKey?.trim();
            if (!key) continue;
            if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
                const oldestKey = this.entries.keys().next().value;
                if (oldestKey) this.entries.delete(oldestKey);
            }
            this.entries.delete(key);
            this.entries.set(key, { entry, expiresAt });
        }
    }

    public get(keys: readonly (string | undefined)[]): YtDlpEntry | null {
        const now = Date.now();
        for (const rawKey of keys) {
            const key = rawKey?.trim();
            if (!key) continue;
            const hit = this.entries.get(key);
            if (!hit) continue;
            if (hit.expiresAt <= now) {
                this.entries.delete(key);
                continue;
            }
            return hit.entry;
        }
        return null;
    }

    public delete(keys: readonly (string | undefined)[]): void {
        for (const rawKey of keys) {
            const key = rawKey?.trim();
            if (key) this.entries.delete(key);
        }
    }
}

export class YtDlpClient {
    private binaryPath: string;
    private readonly scriptsDir: string;
    private cookiesPath: string | null;
    private visitorData: string | null;
    private readonly defaultForceIpv4: boolean;
    private readonly logger?: Logger;
    private updateTimer: NodeJS.Timeout | null = null;
    private cookieTmpSeq = 0;

    public constructor(options: YtDlpClientOptions) {
        this.scriptsDir = resolve(options.cacheDir, "scripts");
        this.cookiesPath = options.cookiesPath ?? null;
        this.visitorData = options.visitorData ?? null;
        this.defaultForceIpv4 = options.forceIpv4 === true;
        this.logger = options.logger;
        this.binaryPath = this.resolveInitialBinaryPath(options.binaryPath);
    }

    public setCookiesPath(path: string | null): void {
        this.cookiesPath = path;
    }

    public getCookiesPath(): string | null {
        return this.cookiesPath;
    }

    public setVisitorData(visitorData: string | null): void {
        this.visitorData = visitorData;
    }

    public getVisitorData(): string | null {
        return this.visitorData;
    }

    public getBinaryPath(): string {
        return this.binaryPath;
    }

    public isAvailable(): boolean {
        return this.binaryPath !== "yt-dlp" ? existsSync(this.binaryPath) : true;
    }

    public async ensureBinary(): Promise<string> {
        if (this.binaryPath !== "yt-dlp" && existsSync(this.binaryPath)) {
            return this.binaryPath;
        }
        // Check if global yt-dlp exists on PATH
        const onPath = await this.probeVersion("yt-dlp");
        if (onPath) {
            this.binaryPath = "yt-dlp";
            return this.binaryPath;
        }

        const isWin = platform() === "win32";
        const filename = isWin ? "yt-dlp.exe" : "yt-dlp";
        const localBin = join(this.scriptsDir, filename);

        if (existsSync(localBin)) {
            this.binaryPath = localBin;
            return localBin;
        }

        mkdirSync(this.scriptsDir, { recursive: true });
        const downloadUrl = isWin
            ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
            : platform() === "darwin"
              ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
              : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";

        this.logger?.info({ downloadUrl, target: localBin }, "Downloading yt-dlp binary");
        const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) });
        if (!res.ok) {
            throw new ProviderError(
                `Failed to download yt-dlp binary (HTTP ${res.status})`,
                "network",
                true,
            );
        }
        const buf = Buffer.from(await res.arrayBuffer());
        writeFileSync(localBin, buf);
        if (!isWin) {
            chmodSync(localBin, 0o755);
        }
        this.binaryPath = localBin;
        return localBin;
    }

    public startAutoUpdater(isIdle: () => boolean, intervalMs = 1_800_000): void {
        this.stopAutoUpdater();
        this.updateTimer = setInterval(() => {
            if (!isIdle()) return;
            void this.runUpdate().catch((err) => {
                this.logger?.debug({ err }, "yt-dlp background update check skipped/failed");
            });
        }, intervalMs);
        this.updateTimer.unref?.();
    }

    public stopAutoUpdater(): void {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
            this.updateTimer = null;
        }
    }

    public async getVersion(): Promise<string | null> {
        return this.probeVersion(this.binaryPath);
    }

    public async dumpJson(target: string, options: YtDlpDumpOptions = {}): Promise<YtDlpEntry> {
        const buildArgs = (withRemoteComponents: boolean): string[] => {
            const args = [
                "--dump-single-json",
                "--skip-download",
                "--quiet",
                "--no-warnings",
                "--no-check-certificates",
                "--js-runtimes",
                "node",
            ];

            if (withRemoteComponents) {
                args.push("--remote-components", "ejs:github");
            }

            // Only ignore per-item errors on playlist dumps so single-track lookups never silently print "null"
            if (options.ignoreErrors ?? Boolean(options.flatPlaylist || options.yesPlaylist)) {
                args.push("--ignore-errors");
            }

            if (options.format) {
                args.push("-f", options.format);
            }
            if (options.extractorArgs) {
                const mergedExtractorArgs =
                    this.visitorData &&
                    options.extractorArgs.startsWith("youtube:") &&
                    !options.extractorArgs.includes("visitor_data=")
                        ? `${options.extractorArgs};visitor_data=${this.visitorData}`
                        : options.extractorArgs;
                args.push("--extractor-args", mergedExtractorArgs);
            }
            if (options.flatPlaylist) args.push("--flat-playlist");
            if (options.noPlaylist) args.push("--no-playlist");
            if (options.yesPlaylist) args.push("--yes-playlist");
            if (options.playlistStart !== undefined)
                args.push("--playlist-start", String(options.playlistStart));
            if (options.playlistEnd !== undefined)
                args.push("--playlist-end", String(options.playlistEnd));
            if (options.forceIpv4 ?? this.defaultForceIpv4) {
                args.push("-4");
            }

            this.appendAuthArgs(args, {
                skipCookies: options.skipCookies,
                hasYoutubeExtractorArgs: Boolean(options.extractorArgs?.startsWith("youtube:")),
            });
            args.push("--", target);
            return args;
        };

        const timeoutMs = options.timeoutMs ?? 25_000;
        let result = await this.execCapture(buildArgs(false), timeoutMs, options.signal);

        // Retry with remote EJS solver components only when bundled solver hits a JS/challenge error
        const lowerErr = result.stderr.toLowerCase();
        const needsRemoteEjs =
            result.exitCode !== 0 &&
            !lowerErr.includes("not a bot") &&
            !lowerErr.includes("confirm your age") &&
            !lowerErr.includes("age-restricted") &&
            !lowerErr.includes("unavailable") &&
            !lowerErr.includes("private video") &&
            !lowerErr.includes("429") &&
            (lowerErr.includes("ejs") ||
                lowerErr.includes("challenge") ||
                lowerErr.includes("n sig") ||
                lowerErr.includes("signature"));
        if (needsRemoteEjs && !options.signal?.aborted) {
            const withRemote = await this.execCapture(buildArgs(true), timeoutMs, options.signal);
            if (withRemote.stdout.trim().length > 0 || withRemote.exitCode === 0) {
                result = withRemote;
            }
        }

        const { stdout, stderr, exitCode } = result;

        if (stdout.trim().length > 0) {
            try {
                const parsed = JSON.parse(stdout) as YtDlpEntry | null;
                if (parsed && typeof parsed === "object") {
                    return parsed;
                }
                if (stderr.trim()) {
                    throw classifyYtDlpError(stderr);
                }
                throw new ProviderError(
                    `yt-dlp returned empty metadata for ${target}`,
                    "unavailable",
                    true,
                );
            } catch (err) {
                if (err instanceof ProviderError || err instanceof RateLimitError) {
                    throw err;
                }
                if (stderr.trim()) {
                    throw classifyYtDlpError(stderr);
                }
                throw new ProviderError(
                    "Failed to parse yt-dlp JSON metadata",
                    "internal",
                    true,
                    err,
                );
            }
        }

        if (stderr.trim()) {
            throw classifyYtDlpError(stderr);
        }
        throw new ProviderError(
            `yt-dlp exited with code ${exitCode} and empty output`,
            "network",
            true,
        );
    }

    public spawnAudioStream(
        targetUrl: string,
        options: { format?: string; signal?: AbortSignal } = {},
    ): { stream: Readable; process: ChildProcess; kill: () => void } {
        const args = [
            "-f",
            options.format ?? "bestaudio[acodec=opus]/bestaudio/best",
            "-o",
            "-",
            "--quiet",
            "--no-warnings",
            "--no-playlist",
            "--js-runtimes",
            "node",
            "--remote-components",
            "ejs:github",
        ];
        const tmpCookiePath = this.appendAuthArgs(args);
        args.push("--", targetUrl);

        const child = spawn(this.binaryPath, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        if (tmpCookiePath) {
            child.once("close", () => {
                try {
                    unlinkSync(tmpCookiePath);
                } catch {
                    // Ignore cleanup race
                }
            });
        }

        let stderrRing = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderrRing = (stderrRing + chunk).slice(-2048);
        });

        const kill = () => {
            if (!child.killed) {
                child.kill("SIGTERM");
                const hardTimer = setTimeout(() => {
                    if (child.exitCode === null) {
                        child.kill("SIGKILL");
                    }
                }, 1_500);
                hardTimer.unref?.();
            }
        };

        if (options.signal) {
            if (options.signal.aborted) {
                kill();
            } else {
                options.signal.addEventListener("abort", kill, { once: true });
                child.once("close", () => {
                    options.signal?.removeEventListener("abort", kill);
                });
            }
        }

        return {
            stream: child.stdout as Readable,
            process: child,
            kill,
        };
    }

    private resolveInitialBinaryPath(configured?: string | null): string {
        if (configured && existsSync(configured)) {
            return configured;
        }
        const isWin = platform() === "win32";
        const local = join(this.scriptsDir, isWin ? "yt-dlp.exe" : "yt-dlp");
        if (existsSync(local)) {
            return local;
        }
        return "yt-dlp";
    }

    private appendAuthArgs(
        args: string[],
        opts: { skipCookies?: boolean; hasYoutubeExtractorArgs?: boolean } = {},
    ): string | null {
        if (this.visitorData && !opts.hasYoutubeExtractorArgs) {
            args.push("--extractor-args", `youtube:visitor_data=${this.visitorData}`);
        }
        if (opts.skipCookies) {
            args.push("--no-cookies");
            return null;
        }
        if (this.cookiesPath && existsSync(this.cookiesPath)) {
            const st = statSync(this.cookiesPath);
            if (st.size > 0) {
                const seq = ++this.cookieTmpSeq;
                const tmpPath = join(
                    dirname(this.cookiesPath),
                    `.ytdlp-tmp-cookies-${process.pid}-${seq}.txt`,
                );
                try {
                    copyFileSync(this.cookiesPath, tmpPath);
                    args.push("--cookies", tmpPath);
                    return tmpPath;
                } catch {
                    args.push("--cookies", this.cookiesPath);
                }
            }
        }
        return null;
    }

    private async probeVersion(bin: string): Promise<string | null> {
        return new Promise((resolve) => {
            const child = spawn(bin, ["--version"], {
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
            });
            let out = "";
            child.stdout?.setEncoding("utf8");
            child.stdout?.on("data", (d: string) => {
                out += d;
            });
            child.once("error", () => resolve(null));
            child.once("close", (code) => {
                resolve(code === 0 ? out.trim() || null : null);
            });
        });
    }

    private async runUpdate(): Promise<void> {
        if (this.binaryPath === "yt-dlp") return;
        await this.execCapture(["-U"], 60_000);
    }

    private execCapture(
        args: string[],
        timeoutMs: number,
        signal?: AbortSignal,
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.binaryPath, args, {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            let stdout = "";
            let stderr = "";
            let settled = false;

            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    child.kill("SIGKILL");
                    reject(new ProviderError("yt-dlp metadata lookup timed out", "network", true));
                }
            }, timeoutMs);
            timer.unref?.();

            const onAbort = () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    child.kill("SIGKILL");
                    reject(new ProviderError("yt-dlp operation aborted", "network", false));
                }
            };

            if (signal) {
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
            }

            child.stdout?.setEncoding("utf8");
            child.stdout?.on("data", (chunk: string) => {
                stdout += chunk;
            });
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => {
                stderr = (stderr + chunk).slice(-8192);
            });

            child.once("error", (err) => {
                const cookieIdx = args.indexOf("--cookies");
                const cookieFile = cookieIdx >= 0 ? args[cookieIdx + 1] : undefined;
                if (cookieFile?.includes(".ytdlp-tmp-cookies-")) {
                    try {
                        unlinkSync(cookieFile);
                    } catch {
                        // Ignore cleanup error
                    }
                }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                reject(
                    new ProviderError(
                        `Failed to spawn yt-dlp: ${err.message}`,
                        "internal",
                        false,
                        err,
                    ),
                );
            });

            child.once("close", (code) => {
                const cookieIdx = args.indexOf("--cookies");
                const cookieFile = cookieIdx >= 0 ? args[cookieIdx + 1] : undefined;
                if (cookieFile?.includes(".ytdlp-tmp-cookies-")) {
                    try {
                        unlinkSync(cookieFile);
                    } catch {
                        // Ignore cleanup error
                    }
                }
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener("abort", onAbort);
                resolve({ stdout, stderr, exitCode: code ?? -1 });
            });
        });
    }
}

export function isHlsFormat(
    fmt: { url?: string; protocol?: string; ext?: string } | null | undefined,
): boolean {
    if (!fmt) return false;
    const proto = fmt.protocol?.toLowerCase() ?? "";
    const url = fmt.url?.toLowerCase() ?? "";
    const ext = fmt.ext?.toLowerCase() ?? "";
    return proto.includes("m3u8") || url.includes(".m3u8") || ext === "m3u8";
}

function isPlayableAudioCandidate(
    fmt: YtDlpFormatEntry | null | undefined,
): fmt is YtDlpFormatEntry {
    if (!fmt || typeof fmt !== "object" || !fmt.url) {
        return false;
    }
    const ext = fmt.ext?.toLowerCase() ?? "";
    const proto = fmt.protocol?.toLowerCase() ?? "";
    const formatId = fmt.format_id?.toLowerCase() ?? "";
    if (ext === "mhtml" || proto === "mhtml" || formatId.startsWith("sb")) {
        return false;
    }

    const acodec = fmt.acodec?.toLowerCase();
    const vcodec = fmt.vcodec?.toLowerCase();
    if (acodec === "none") {
        return false;
    }

    const isAudioOnly = !vcodec || vcodec === "none";
    if (isAudioOnly) {
        // Accept explicit audio formats AND HLS audio-only manifests where yt-dlp omits acodec (e.g. YouTube itag 233/234)
        return Boolean(acodec) || isHlsFormat(fmt);
    }

    // Muxed audio+video fallback (e.g. YouTube android/tv_simply format 18) must explicitly declare an audio codec
    return Boolean(acodec);
}

function estimateFormatAudioKbps(fmt: YtDlpFormatEntry): number {
    if (typeof fmt.abr === "number" && Number.isFinite(fmt.abr) && fmt.abr > 0) {
        return fmt.abr;
    }
    const isAudioOnly = !fmt.vcodec || fmt.vcodec.toLowerCase() === "none";
    if (isAudioOnly && typeof fmt.tbr === "number" && Number.isFinite(fmt.tbr) && fmt.tbr > 0) {
        return fmt.tbr;
    }
    switch (fmt.format_id) {
        case "234":
            return 132;
        case "251":
        case "140":
        case "141":
            return 128;
        case "250":
            return 68;
        case "249":
        case "233":
            return 50;
        case "139":
            return 48;
        default:
            return 0;
    }
}

function getFormatQualityTier(fmt: YtDlpFormatEntry): number {
    const isMuxed = Boolean(fmt.vcodec && fmt.vcodec.toLowerCase() !== "none");
    if (isMuxed) {
        return 0;
    }
    const hls = isHlsFormat(fmt);
    const kbps = estimateFormatAudioKbps(fmt);
    if (!hls) {
        // Tier 4: progressive direct high-bitrate / unspecified bitrate (e.g. 251, 140); Tier 2: low-bitrate progressive (e.g. 250, 249, 139)
        return kbps === 0 || kbps >= 96 ? 4 : 2;
    }
    // Tier 3: high-bitrate HLS audio-only (e.g. YouTube 234 132k AAC-LC); Tier 1: low-bitrate HLS audio-only (e.g. 233)
    return kbps >= 96 ? 3 : 1;
}

/**
 * Returns all playable audio format candidates from a yt-dlp entry ordered from
 * highest practical audio fidelity & lowest overhead down to fallback formats.
 */
export function listAudioFormatCandidates(
    entry: YtDlpEntry | null | undefined,
): YtDlpFormatEntry[] {
    if (!entry || typeof entry !== "object") {
        return [];
    }

    const byUrl = new Map<string, YtDlpFormatEntry>();
    for (const f of [...(entry.requested_formats ?? []), ...(entry.formats ?? [])]) {
        if (isPlayableAudioCandidate(f) && f.url && !byUrl.has(f.url)) {
            byUrl.set(f.url, f);
        }
    }

    if (entry.url && !byUrl.has(entry.url)) {
        const topLevel: YtDlpFormatEntry = {
            url: entry.url,
            ext: entry.ext,
            acodec: entry.acodec,
            vcodec: entry.vcodec,
            asr: entry.asr,
            audio_channels: entry.audio_channels,
            abr: entry.abr,
            http_headers: entry.http_headers,
        };
        if (
            isPlayableAudioCandidate(topLevel) ||
            (byUrl.size === 0 &&
                entry.ext?.toLowerCase() !== "mhtml" &&
                entry.acodec?.toLowerCase() !== "none")
        ) {
            byUrl.set(entry.url, topLevel);
        }
    }

    const candidates = [...byUrl.values()];
    candidates.sort((a, b) => {
        const tierDiff = getFormatQualityTier(b) - getFormatQualityTier(a);
        if (tierDiff !== 0) return tierDiff;

        // Strongly prefer progressive direct HTTP streams over segmented HLS (.m3u8) playlists
        const aDirect = isHlsFormat(a) ? 0 : 1;
        const bDirect = isHlsFormat(b) ? 0 : 1;
        if (aDirect !== bDirect) return bDirect - aDirect;

        // Prefer native 48 kHz Opus (supports lossless Discord Opus passthrough)
        const aOpus =
            a.acodec?.toLowerCase().includes("opus") && (!a.asr || a.asr === 48_000) ? 1 : 0;
        const bOpus =
            b.acodec?.toLowerCase().includes("opus") && (!b.asr || b.asr === 48_000) ? 1 : 0;
        if (aOpus !== bOpus) return bOpus - aOpus;

        const kbpsDiff = estimateFormatAudioKbps(b) - estimateFormatAudioKbps(a);
        if (kbpsDiff !== 0) return kbpsDiff;

        return (b.asr ?? 0) - (a.asr ?? 0);
    });

    return candidates;
}

export function extractBestAudioFormat(
    entry: YtDlpEntry | null | undefined,
): YtDlpFormatEntry | null {
    return listAudioFormatCandidates(entry)[0] ?? null;
}

/**
 * Verifies with a tiny byte-range or HLS manifest+segment request that the CDN URL
 * actually serves bytes (200/206) instead of returning HTTP 403/404 at playback time.
 */
export async function probeCandidateStreamable(
    fmt: YtDlpFormatEntry,
    fallbackHeaders: Record<string, string> | undefined,
    signal?: AbortSignal,
): Promise<boolean> {
    if (!fmt.url) return false;
    if (!fmt.url.startsWith("http://") && !fmt.url.startsWith("https://")) {
        return true;
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), 1_500);

    try {
        const baseHeaders: Record<string, string> = {
            ...(fallbackHeaders ?? {}),
            ...(fmt.http_headers ?? {}),
        };

        if (!isHlsFormat(fmt)) {
            const res = await fetch(fmt.url, {
                method: "GET",
                headers: baseHeaders,
                signal: controller.signal,
            });
            await res.body?.cancel().catch(() => undefined);
            return res.status === 200 || res.status === 206;
        }

        const res = await fetch(fmt.url, {
            method: "GET",
            headers: baseHeaders,
            signal: controller.signal,
        });
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            return false;
        }

        const manifest = await res.text();
        if (!manifest.includes("#EXTM3U")) {
            return false;
        }

        const firstSegmentUrl = manifest
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && !line.startsWith("#") && /^https?:\/\//i.test(line));
        if (!firstSegmentUrl) {
            return true;
        }

        const segRes = await fetch(firstSegmentUrl, {
            method: "GET",
            headers: { ...baseHeaders, Range: "bytes=0-63" },
            signal: controller.signal,
        });
        await segRes.body?.cancel().catch(() => undefined);
        return segRes.status === 200 || segRes.status === 206;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
    }
}

export async function selectPlayableFormatFromEntry(
    entry: YtDlpEntry | null | undefined,
    signal?: AbortSignal,
    options: { excludePreviewFormats?: boolean; maxCandidates?: number } = {},
): Promise<YtDlpFormatEntry | null> {
    if (!entry) return null;
    let candidates = listAudioFormatCandidates(entry);
    if (options.excludePreviewFormats) {
        const nonPreview = candidates.filter(
            (fmt) => !fmt.format_id?.toLowerCase().includes("_preview"),
        );
        if (nonPreview.length > 0) {
            candidates = nonPreview;
        }
    }

    const bounded = candidates.slice(0, options.maxCandidates ?? 8);
    if (bounded.length === 0 || signal?.aborted) {
        return null;
    }

    // Fast path: probe top-ranked format first (1 RTT when valid), then probe fallbacks concurrently
    const first = bounded[0];
    if (first && (await probeCandidateStreamable(first, entry?.http_headers, signal))) {
        return first;
    }
    if (bounded.length === 1 || signal?.aborted) {
        return null;
    }

    const checks = await Promise.all(
        bounded
            .slice(1)
            .map(async (fmt) =>
                (await probeCandidateStreamable(fmt, entry?.http_headers, signal)) ? fmt : null,
            ),
    );
    return checks.find((fmt): fmt is YtDlpFormatEntry => fmt !== null) ?? null;
}

export { readFileSync };
