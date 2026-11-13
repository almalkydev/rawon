import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { DiskAudioCache, PrefetchCoordinator, RedisMetadataCache } from "@rawon/cache";
import { loadConfig, loadEnvFiles } from "@rawon/config";
import { type CoordinatorService, InMemoryCoordinator, RedisCoordinator } from "@rawon/database";
import { ProviderRegistry, YtDlpClient } from "@rawon/providers";
import { createLogger, type Track } from "@rawon/shared";

async function bootstrapWorker(): Promise<void> {
    loadEnvFiles();
    const config = loadConfig();

    const logger = createLogger({
        scope: "rawon-worker",
        level: config.debugMode ? "debug" : "info",
        pretty: !config.isDev ? false : undefined,
        redactSecrets: [config.redisUrl, config.stegripeApiLyricsToken, config.spotifyClientSecret],
    });

    logger.info(
        { concurrency: config.workerConcurrency },
        "Starting Rawon V2 background audio worker",
    );

    const coordinator: CoordinatorService = config.redisUrl
        ? new RedisCoordinator({ redisUrl: config.redisUrl, logger })
        : new InMemoryCoordinator();
    await coordinator.connect().catch((err) => {
        logger.warn({ err }, "Worker coordinator connect failed; running locally");
    });

    const metadataCache = new RedisMetadataCache({
        redisUrl: config.redisUrl || null,
        logger,
    });
    await metadataCache.connect();

    const diskCache = new DiskAudioCache({
        cacheDir: join(config.cacheDir, "audio"),
        maxBytes: config.audioCacheMaxBytes,
        maxFiles: config.audioCacheMaxFiles,
        logger,
    });
    await diskCache.initialize();

    const prefetch = new PrefetchCoordinator({
        maxConcurrency: config.workerConcurrency,
        logger,
    });

    const ytdlp = new YtDlpClient({
        binaryPath: config.ytDlpPath,
        cacheDir: config.cacheDir,
        logger,
    });
    await ytdlp.ensureBinary().catch((err) => {
        logger.warn({ err }, "yt-dlp binary check failed in worker");
    });
    ytdlp.startAutoUpdater(() => prefetch.getActiveCount() === 0);

    const providers = new ProviderRegistry({
        ytdlp,
        spotifyClientId: config.spotifyClientId,
        spotifyClientSecret: config.spotifyClientSecret,
        spotifyMarket: config.spotifyMarket,
        stegripeApiUrl: config.stegripeApiUrl,
        stegripeApiLyricsToken: config.stegripeApiLyricsToken,
        metadataCache,
        logger,
    });

    // Listen for distributed precache requests published by bot instances
    const unsubscribe = coordinator.onEvent((event) => {
        if (event.type !== "precache_request") return;
        const track = event.payload.track as Track | undefined;
        if (!track?.url || track.isLive) return;
        const canonicalKey = `${track.provider}:${track.id || track.url}`;
        if (diskCache.peekWithoutStats(canonicalKey) || diskCache.isInProgress(canonicalKey)) {
            return;
        }

        prefetch.schedule({
            key: canonicalKey,
            run: async (signal) => {
                const desc = await providers.getStreamDescriptor(track, { signal });
                if (desc.isLive || desc.sourceType !== "url") return;
                const res = await fetch(desc.url, { headers: desc.headers, signal });
                if (!res.ok || !res.body) return;
                const nodeStream = Readable.fromWeb(
                    res.body as import("node:stream/web").ReadableStream<Uint8Array>,
                );
                const { completion } = await diskCache.cacheFromStream(
                    canonicalKey,
                    nodeStream,
                    {
                        container: desc.container,
                        codec: desc.codec,
                        sampleRate: desc.sampleRate,
                        channels: desc.channels,
                        durationSeconds: desc.durationSeconds,
                    },
                    { teeToPlayback: false },
                );
                await completion;
            },
        });
    });

    // Periodic disk cache maintenance (every 5 minutes)
    const gcTimer = setInterval(() => {
        void diskCache.evictIfNeeded().catch(() => undefined);
    }, 300_000);
    gcTimer.unref?.();

    const workerPort = Number(process.env.WORKER_HEALTH_PORT ?? "9091");
    const server = createServer((req, res) => {
        if (req.url === "/healthz") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
                JSON.stringify({
                    status: "ok",
                    activePrefetches: prefetch.getActiveCount(),
                    pendingPrefetches: prefetch.getPendingCount(),
                    cacheStats: diskCache.getStats(),
                }),
            );
            return;
        }
        res.writeHead(404);
        res.end("Not Found");
    });

    if (workerPort > 0) {
        server.listen(workerPort, config.metricsHost, () => {
            logger.info(
                { host: config.metricsHost, port: workerPort },
                "Worker health endpoint ready",
            );
        });
    }

    const shutdown = async (signal: string) => {
        logger.info({ signal }, "Shutting down audio worker");
        unsubscribe();
        clearInterval(gcTimer);
        ytdlp.stopAutoUpdater();
        prefetch.cancelAll();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await coordinator.close();
        await metadataCache.close();
        process.exit(0);
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

bootstrapWorker().catch((err) => {
    console.error("Fatal error starting Rawon V2 worker:", err);
    process.exit(1);
});
