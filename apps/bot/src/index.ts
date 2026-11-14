import { join } from "node:path";
import { AudioPipeline, ProcessSupervisor } from "@rawon/audio-engine";
import { DiskAudioCache, PrefetchCoordinator, RedisMetadataCache } from "@rawon/cache";
import { I18nService, loadConfig, loadEnvFiles } from "@rawon/config";
import {
    type CoordinatorService,
    type DatabaseStore,
    InMemoryCoordinator,
    MemoryDatabaseStore,
    PostgresDatabaseStore,
    RedisCoordinator,
} from "@rawon/database";
import { MultiBotSupervisor } from "@rawon/discord";
import { SessionManager } from "@rawon/music-core";
import { ProviderRegistry, YtDlpClient } from "@rawon/providers";
import { createLogger } from "@rawon/shared";
import { startHealthAndMetricsServer } from "./healthServer.js";

async function waitForPostgres(
    store: PostgresDatabaseStore,
    logger: ReturnType<typeof createLogger>,
) {
    let attempt = 0;
    while (attempt < 10) {
        try {
            await store.initialize();
            return;
        } catch (err) {
            attempt += 1;
            const delayMs = Math.min(5_000, attempt * 1_000);
            logger.warn({ err, attempt, delayMs }, "Waiting for PostgreSQL to accept connections");
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    await store.initialize();
}

async function bootstrap(): Promise<void> {
    loadEnvFiles();
    const config = loadConfig();

    const logger = createLogger({
        scope: "rawon-bot",
        level: config.debugMode ? "debug" : "info",
        pretty: !config.isDev ? false : undefined,
        redactSecrets: [
            ...config.discordTokens,
            config.databaseUrl,
            config.redisUrl,
            config.stegripeApiLyricsToken,
            config.spotifyClientSecret,
            config.cookiesEncryptionKey ?? "",
            config.youtubeCookies ?? "",
        ],
    });

    logger.info(
        {
            nodeEnv: config.nodeEnv,
            botsConfigured: config.discordTokens.length,
            isMultiBot: config.isMultiBot,
            audioProfile: config.audioQualityProfile,
        },
        "Starting Rawon V2 bot platform",
    );

    const store: DatabaseStore = config.databaseUrl
        ? new PostgresDatabaseStore({
              connectionString: config.databaseUrl,
              maxConnections: 15,
              logger,
          })
        : new MemoryDatabaseStore();

    if (store instanceof PostgresDatabaseStore) {
        await waitForPostgres(store, logger);
    } else {
        await store.initialize();
    }

    const coordinator: CoordinatorService = config.redisUrl
        ? new RedisCoordinator({
              redisUrl: config.redisUrl,
              logger,
          })
        : new InMemoryCoordinator();

    await coordinator.connect().catch((err) => {
        logger.warn({ err }, "Coordinator connect deferred; falling back to local coordination");
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
        forceIpv4: config.ytDlpForceIpv4,
        logger,
    });
    await ytdlp.ensureBinary().catch((err) => {
        logger.warn({ err }, "yt-dlp binary check/download failed at startup");
    });

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

    const supervisor = new ProcessSupervisor({ logger });
    const audioPipeline = new AudioPipeline({
        supervisor,
        ffmpegPath: config.ffmpegPath,
        logger,
    });

    const sessions = new SessionManager({
        store,
        coordinator,
        providers,
        audioPipeline,
        diskCache,
        prefetch,
        logger,
    });

    ytdlp.startAutoUpdater(() => sessions.getActiveCount() === 0);

    const i18n = new I18nService(config.defaultLocale);

    const botSupervisor = new MultiBotSupervisor({
        config,
        store,
        coordinator,
        providers,
        audioPipeline,
        diskCache,
        prefetch,
        sessions,
        i18n,
        logger,
    });

    const httpServer = startHealthAndMetricsServer({
        host: config.metricsHost,
        port: config.metricsPort,
        sessions,
        getBotCount: () => config.discordTokens.length,
        logger,
    });

    await botSupervisor.start();

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info({ signal }, "Graceful shutdown initiated");

        const forceTimer = setTimeout(() => {
            logger.error("Forced exit after shutdown timeout");
            process.exit(1);
        }, 15_000);
        forceTimer.unref();

        try {
            ytdlp.stopAutoUpdater();
            prefetch.cancelAll();
            await botSupervisor.shutdown();
            await new Promise<void>((resolve) => {
                if (!httpServer) {
                    resolve();
                    return;
                }
                httpServer.close(() => resolve());
            });
            await coordinator.close();
            await metadataCache.close();
            await store.close();
            clearTimeout(forceTimer);
            logger.info("Shutdown complete");
            process.exit(0);
        } catch (err) {
            logger.error({ err }, "Error during graceful shutdown");
            process.exit(1);
        }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
        logger.error({ err: reason }, "Unhandled promise rejection");
    });
    process.on("uncaughtException", (err) => {
        logger.error({ err }, "Uncaught exception");
    });
}

bootstrap().catch((err) => {
    console.error("Fatal error starting Rawon V2 bot:", err);
    process.exit(1);
});
