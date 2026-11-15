import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { SUPPORTED_LOCALES, type SupportedLocale } from "./i18n.js";

const yesNoSchema = z
    .string()
    .optional()
    .transform((val) => val?.trim().toLowerCase() ?? "");

const optionalPositiveInt = (fallback: number) =>
    z.coerce.number().int().positive().catch(fallback).default(fallback);

const optionalNonNegativeInt = (fallback: number) =>
    z.coerce.number().int().min(0).catch(fallback).default(fallback);

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
    DEBUG_MODE: yesNoSchema.transform((v) => v === "yes" || v === "true"),
    DISCORD_TOKEN: z.string().default(""),
    MAIN_PREFIX: z.string().default("!"),
    DEV_PREFIX: z.string().default(""),
    MAIN_SERVER: z.string().default(""),
    DEVS: z.string().default(""),
    LOCALE: z.string().default("en-US"),
    ACTIVITY_TYPES: z.string().default("PLAYING"),
    ACTIVITIES: z.string().default("music on {totalGuilds} servers"),
    ENABLE_PREFIX: yesNoSchema.transform((v) => v !== "no" && v !== "false"),
    ENABLE_SLASH_COMMAND: yesNoSchema.transform((v) => v !== "no" && v !== "false"),
    ENABLE_SHARDING: yesNoSchema.transform((v) => v === "yes" || v === "true"),
    STEGRIPE_API_URL: z.string().url().default("https://api.stegripe.org"),
    STEGRIPE_API_LYRICS_TOKEN: z.string().default(""),
    SPOTIFY_CLIENT_ID: z.string().default(""),
    SPOTIFY_CLIENT_SECRET: z.string().default(""),
    SPOTIFY_MARKET: z.string().default("US"),
    DEVTOOLS_PORT: optionalPositiveInt(3000),
    CHROMIUM_PATH: z.string().default(""),
    DATABASE_URL: z.string().default("postgres://rawon:rawon@postgres:5432/rawon"),
    REDIS_URL: z.string().default("redis://redis:6379"),
    CACHE_DIR: z.string().default("cache"),
    DATA_DIR: z.string().default("data"),
    AUDIO_CACHE_MAX_MB: optionalPositiveInt(500),
    AUDIO_CACHE_MAX_FILES: optionalPositiveInt(50),
    AUDIO_QUALITY_PROFILE: z.enum(["fidelity", "balanced", "low-bandwidth"]).default("fidelity"),
    AUDIO_NORMALIZE: yesNoSchema.transform((v) => v === "yes" || v === "true"),
    COOKIES_ENCRYPTION_KEY: z.string().default(""),
    YOUTUBE_COOKIES: z.string().default(""),
    YTDLP_FORCE_IPV4: yesNoSchema.transform((v) => v === "yes" || v === "true"),
    POT_PROVIDER_URL: z.string().default(""),
    MAX_QUEUE_SIZE: optionalPositiveInt(500),
    RC_RATE_LIMIT_MAX: optionalPositiveInt(5),
    RC_RATE_LIMIT_WINDOW_MS: optionalPositiveInt(15_000),
    METRICS_PORT: optionalNonNegativeInt(9090),
    METRICS_HOST: z.string().default("127.0.0.1"),
    WORKER_CONCURRENCY: optionalPositiveInt(2),
    FFMPEG_PATH: z.string().default(""),
    YT_DLP_PATH: z.string().default(""),
});

export interface RawonConfig {
    nodeEnv: "development" | "production" | "test";
    isDev: boolean;
    debugMode: boolean;
    discordTokens: string[];
    isMultiBot: boolean;
    mainPrefix: string;
    mainServer: string | null;
    devs: string[];
    defaultLocale: SupportedLocale;
    activityTypes: string[];
    activities: string[];
    enablePrefix: boolean;
    enableSlashCommand: boolean;
    enableSharding: boolean;
    stegripeApiUrl: string;
    stegripeApiLyricsToken: string;
    spotifyClientId: string;
    spotifyClientSecret: string;
    spotifyMarket: string;
    devtoolsPort: number;
    chromiumPath: string | null;
    databaseUrl: string;
    redisUrl: string;
    cacheDir: string;
    dataDir: string;
    audioCacheMaxBytes: number;
    audioCacheMaxFiles: number;
    audioQualityProfile: "fidelity" | "balanced" | "low-bandwidth";
    audioNormalize: boolean;
    cookiesEncryptionKey: string | null;
    youtubeCookies: string | null;
    ytDlpForceIpv4: boolean;
    potProviderUrl: string | null;
    maxQueueSize: number;
    rcRateLimitMax: number;
    rcRateLimitWindowMs: number;
    metricsPort: number;
    metricsHost: string;
    workerConcurrency: number;
    ffmpegPath: string | null;
    ytDlpPath: string | null;
}

function splitCsv(raw: string): string[] {
    return raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
}

export function loadEnvFiles(cwd = process.cwd()): void {
    const devEnvPath = resolve(cwd, "dev.env");
    const envPath = resolve(cwd, ".env");
    if (existsSync(devEnvPath)) {
        loadDotenv({ path: devEnvPath, override: false });
    }
    if (existsSync(envPath)) {
        loadDotenv({ path: envPath, override: false });
    }
}

export function loadConfig(
    envInput: Record<string, string | undefined> = process.env,
): RawonConfig {
    const parsed = envSchema.parse(envInput);
    const discordTokens = splitCsv(parsed.DISCORD_TOKEN);
    const isDev = parsed.NODE_ENV === "development";
    const resolvedLocale =
        SUPPORTED_LOCALES.find((loc) => loc.toLowerCase() === parsed.LOCALE.trim().toLowerCase()) ??
        "en-US";

    const mainPrefix =
        parsed.DEV_PREFIX.trim().length > 0 && isDev
            ? parsed.DEV_PREFIX.trim()
            : parsed.MAIN_PREFIX.trim() || "!";

    return {
        nodeEnv: parsed.NODE_ENV,
        isDev,
        debugMode: parsed.DEBUG_MODE,
        discordTokens,
        isMultiBot: discordTokens.length > 1,
        mainPrefix,
        mainServer: parsed.MAIN_SERVER.trim() || null,
        devs: splitCsv(parsed.DEVS),
        defaultLocale: resolvedLocale,
        activityTypes: splitCsv(parsed.ACTIVITY_TYPES),
        activities: splitCsv(parsed.ACTIVITIES),
        enablePrefix: parsed.ENABLE_PREFIX,
        enableSlashCommand: parsed.ENABLE_SLASH_COMMAND,
        enableSharding: parsed.ENABLE_SHARDING,
        stegripeApiUrl: parsed.STEGRIPE_API_URL.replace(/\/+$/u, ""),
        stegripeApiLyricsToken: parsed.STEGRIPE_API_LYRICS_TOKEN.trim(),
        spotifyClientId: parsed.SPOTIFY_CLIENT_ID.trim(),
        spotifyClientSecret: parsed.SPOTIFY_CLIENT_SECRET.trim(),
        spotifyMarket: parsed.SPOTIFY_MARKET.trim() || "US",
        devtoolsPort: parsed.DEVTOOLS_PORT,
        chromiumPath: parsed.CHROMIUM_PATH.trim() || null,
        databaseUrl: parsed.DATABASE_URL.trim(),
        redisUrl: parsed.REDIS_URL.trim(),
        cacheDir: resolve(parsed.CACHE_DIR),
        dataDir: resolve(parsed.DATA_DIR),
        audioCacheMaxBytes: parsed.AUDIO_CACHE_MAX_MB * 1024 * 1024,
        audioCacheMaxFiles: parsed.AUDIO_CACHE_MAX_FILES,
        audioQualityProfile: parsed.AUDIO_QUALITY_PROFILE,
        audioNormalize: parsed.AUDIO_NORMALIZE,
        cookiesEncryptionKey: parsed.COOKIES_ENCRYPTION_KEY.trim() || null,
        youtubeCookies: parsed.YOUTUBE_COOKIES.trim() || null,
        ytDlpForceIpv4: parsed.YTDLP_FORCE_IPV4,
        potProviderUrl: parsed.POT_PROVIDER_URL.trim().replace(/\/+$/u, "") || null,
        maxQueueSize: parsed.MAX_QUEUE_SIZE,
        rcRateLimitMax: parsed.RC_RATE_LIMIT_MAX,
        rcRateLimitWindowMs: parsed.RC_RATE_LIMIT_WINDOW_MS,
        metricsPort: parsed.METRICS_PORT,
        metricsHost: parsed.METRICS_HOST.trim() || "127.0.0.1",
        workerConcurrency: parsed.WORKER_CONCURRENCY,
        ffmpegPath: parsed.FFMPEG_PATH.trim() || null,
        ytDlpPath: parsed.YT_DLP_PATH.trim() || null,
    };
}
