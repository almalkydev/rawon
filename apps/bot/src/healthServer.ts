import { createServer, type Server } from "node:http";
import type { SessionManager } from "@rawon/music-core";
import type { Logger } from "@rawon/shared";

export interface HealthServerOptions {
    host: string;
    port: number;
    sessions: SessionManager;
    getBotCount: () => number;
    logger?: Logger;
}

export function startHealthAndMetricsServer(options: HealthServerOptions): Server | null {
    if (options.port <= 0) {
        return null;
    }

    const server = createServer((req, res) => {
        const url = req.url ?? "/";

        if (url === "/healthz" || url === "/health") {
            const metrics = options.sessions.getMetrics();
            const body = JSON.stringify({
                status: "ok",
                botsOnline: options.getBotCount(),
                activeSessions: metrics.activeSessions,
                playingSessions: metrics.playingSessions,
                ffmpegProcesses: metrics.activeFfmpegProcesses,
                uptimeSeconds: Math.round(process.uptime()),
                rssBytes: process.memoryUsage().rss,
            });
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(body);
            return;
        }

        if (url === "/metrics") {
            const metrics = options.sessions.getMetrics();
            const mem = process.memoryUsage();
            const lines = [
                "# HELP rawon_bots_online Number of connected Discord bot runtimes",
                "# TYPE rawon_bots_online gauge",
                `rawon_bots_online ${options.getBotCount()}`,
                "# HELP rawon_active_sessions Number of active guild voice sessions",
                "# TYPE rawon_active_sessions gauge",
                `rawon_active_sessions ${metrics.activeSessions}`,
                "# HELP rawon_playing_sessions Number of actively streaming guild sessions",
                "# TYPE rawon_playing_sessions gauge",
                `rawon_playing_sessions ${metrics.playingSessions}`,
                "# HELP rawon_ffmpeg_processes Active supervised FFmpeg processes",
                "# TYPE rawon_ffmpeg_processes gauge",
                `rawon_ffmpeg_processes ${metrics.activeFfmpegProcesses}`,
                "# HELP rawon_process_rss_bytes Resident set size in bytes",
                "# TYPE rawon_process_rss_bytes gauge",
                `rawon_process_rss_bytes ${mem.rss}`,
                "# HELP rawon_process_heap_used_bytes Heap used in bytes",
                "# TYPE rawon_process_heap_used_bytes gauge",
                `rawon_process_heap_used_bytes ${mem.heapUsed}`,
                "# HELP rawon_process_uptime_seconds Process uptime in seconds",
                "# TYPE rawon_process_uptime_seconds gauge",
                `rawon_process_uptime_seconds ${Math.round(process.uptime())}`,
            ];

            if (metrics.cacheStats) {
                lines.push(
                    "# HELP rawon_audio_cache_entries Total disk-cached audio files",
                    "# TYPE rawon_audio_cache_entries gauge",
                    `rawon_audio_cache_entries ${metrics.cacheStats.entryCount}`,
                    "# HELP rawon_audio_cache_bytes Total bytes stored in disk audio cache",
                    "# TYPE rawon_audio_cache_bytes gauge",
                    `rawon_audio_cache_bytes ${metrics.cacheStats.totalBytes}`,
                    "# HELP rawon_audio_cache_hit_ratio Audio cache hit ratio",
                    "# TYPE rawon_audio_cache_hit_ratio gauge",
                    `rawon_audio_cache_hit_ratio ${metrics.cacheStats.hitRate.toFixed(4)}`,
                );
            }

            res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
            res.end(`${lines.join("\n")}\n`);
            return;
        }

        res.writeHead(404);
        res.end("Not Found");
    });

    server.listen(options.port, options.host, () => {
        options.logger?.info(
            { host: options.host, port: options.port },
            "Health and Prometheus metrics server listening",
        );
    });

    server.on("error", (err) => {
        options.logger?.warn({ err }, "Metrics HTTP server error");
    });

    return server;
}
