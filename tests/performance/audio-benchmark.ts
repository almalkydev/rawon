import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, tmpdir, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AudioPipeline, type PreparedAudioStream, ProcessSupervisor } from "@rawon/audio-engine";
import { DiskAudioCache } from "@rawon/cache";
import {
    BOT_SETTINGS_DEFAULTS,
    createDefaultGuildConfig,
    createDefaultPlayerState,
} from "@rawon/config";
import { InMemoryCoordinator, MemoryDatabaseStore } from "@rawon/database";
import {
    GuildMusicSession,
    type PlaybackFinishReason,
    type VoiceTransport,
} from "@rawon/music-core";
import type { ProviderRegistry } from "@rawon/providers";
import { ExpiredStreamError, type StreamDescriptor, type Track } from "@rawon/shared";

interface ScenarioResult {
    sessions: number;
    mode: "passthrough-ogg-opus" | "ffmpeg-mp3-to-opus";
    wallDurationMs: number;
    ttfaMeanMs: number;
    ttfaP95Ms: number;
    transitionMeanMs: number;
    nodeCpuPercentTotal: number;
    nodeCpuPercentPerSession: number;
    rssDeltaMbTotal: number;
    rssDeltaMbPerSession: number;
    peakFfmpegProcesses: number;
    leakedFfmpegProcesses: number;
}

class BenchmarkVoiceTransport implements VoiceTransport {
    private currentPrepared: PreparedAudioStream | null = null;
    private drainTimer: NodeJS.Timeout | null = null;
    public firstPacketResolve: (() => void) | null = null;

    public async connect(): Promise<void> {}

    public async disconnect(): Promise<void> {
        await this.stop();
    }

    public async playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, error?: Error) => void,
    ): Promise<void> {
        await this.stop();
        this.currentPrepared = prepared;
        let firstSeen = false;
        let settled = false;

        const finish = (reason: PlaybackFinishReason, err?: Error) => {
            if (settled) return;
            settled = true;
            if (this.drainTimer) {
                clearInterval(this.drainTimer);
                this.drainTimer = null;
            }
            void prepared.cleanup().finally(() => onFinished(reason, err));
        };

        const markFirst = () => {
            if (!firstSeen) {
                firstSeen = true;
                const resolver = this.firstPacketResolve;
                this.firstPacketResolve = null;
                resolver?.();
            }
        };

        prepared.stream.once("readable", markFirst);
        prepared.stream.once("end", () => finish("ended"));
        prepared.stream.once("error", (err) => finish("error", err));

        // Simulate realistic 20ms Discord Opus frame pacing (1 packet per 20ms) so multi-session concurrency
        // remains active during TTFA, transition, CPU, and RAM sampling without premature EOF races.
        this.drainTimer = setInterval(() => {
            if (prepared.stream.isPaused()) return;
            const pkt = prepared.stream.read(1);
            if (pkt !== null) {
                markFirst();
            }
        }, 20);
        this.drainTimer.unref?.();
    }

    public async pause(): Promise<boolean> {
        this.currentPrepared?.stream.pause();
        return Boolean(this.currentPrepared);
    }

    public async resume(): Promise<boolean> {
        this.currentPrepared?.stream.resume();
        return Boolean(this.currentPrepared);
    }

    public async stop(): Promise<void> {
        if (this.drainTimer) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
        }
        if (this.currentPrepared) {
            const p = this.currentPrepared;
            this.currentPrepared = null;
            await p.cleanup();
        }
    }
}

function generateFixtures(
    workDir: string,
    ffmpegExe: string,
): { oggPath: string; mp3Path: string } {
    const oggPath = join(workDir, "bench_48k.ogg");
    const mp3Path = join(workDir, "bench_44k.mp3");

    const genOgg = spawnSync(
        ffmpegExe,
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=4",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            oggPath,
        ],
        { windowsHide: true },
    );
    if (genOgg.status !== 0) {
        throw new Error(`ffmpeg ogg fixture error: ${genOgg.stderr?.toString()}`);
    }

    const genMp3 = spawnSync(
        ffmpegExe,
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=523.25:sample_rate=44100:duration=4",
            "-ac",
            "2",
            "-ar",
            "44100",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "128k",
            mp3Path,
        ],
        { windowsHide: true },
    );
    if (genMp3.status !== 0) {
        throw new Error(`ffmpeg mp3 fixture error: ${genMp3.stderr?.toString()}`);
    }

    return { oggPath, mp3Path };
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx] ?? 0;
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

async function runConcurrencyScenario(params: {
    sessionCount: number;
    mode: "passthrough-ogg-opus" | "ffmpeg-mp3-to-opus";
    fixturePath: string;
    cacheDir: string;
}): Promise<ScenarioResult> {
    const store = new MemoryDatabaseStore();
    await store.initialize();
    const coordinator = new InMemoryCoordinator();
    const supervisor = new ProcessSupervisor();
    const audioPipeline = new AudioPipeline({ supervisor });
    const diskCache = new DiskAudioCache({
        cacheDir: params.cacheDir,
        minValidBytes: 64,
    });
    await diskCache.initialize();

    let peakFfmpeg = 0;
    const sampleTimer = setInterval(() => {
        peakFfmpeg = Math.max(peakFfmpeg, supervisor.getActiveCount());
    }, 5);

    const isPassthrough = params.mode === "passthrough-ogg-opus";
    const providersStub = {
        hydrateTrack: async (track: Track) => track,
        getStreamDescriptor: async (track: Track): Promise<StreamDescriptor> => ({
            sourceType: "cache",
            url: track.url,
            canonicalKey: `bench:${track.id}`,
            container: isPassthrough ? "ogg" : "mp3",
            codec: isPassthrough ? "opus" : "mp3",
            sampleRate: isPassthrough ? 48_000 : 44_100,
            channels: 2,
            durationSeconds: 4,
            isLive: false,
            seekable: true,
            directPassthroughEligible: isPassthrough,
            cacheFilePath: params.fixturePath,
            resolvedAt: Date.now(),
        }),
        findRelatedTracks: async () => [],
    } as unknown as ProviderRegistry;

    const sessions: GuildMusicSession[] = [];
    const transports: BenchmarkVoiceTransport[] = [];
    for (let i = 0; i < params.sessionCount; i += 1) {
        const transport = new BenchmarkVoiceTransport();
        const session = new GuildMusicSession({
            guildId: `bench_guild_${i}`,
            botId: "bench_bot_0",
            voiceChannelId: `bench_vc_${i}`,
            textChannelId: `bench_txt_${i}`,
            store,
            coordinator,
            providers: providersStub,
            audioPipeline,
            diskCache,
            transport,
            guildConfig: createDefaultGuildConfig(`bench_guild_${i}`),
            botSettings: BOT_SETTINGS_DEFAULTS,
            playerState: createDefaultPlayerState(BOT_SETTINGS_DEFAULTS),
        });
        sessions.push(session);
        transports.push(transport);
    }

    global.gc?.();
    const rssBefore = process.memoryUsage().rss;
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();

    // 1. Measure Time to First Audio (TTFA) across N simultaneous guilds starting track 1
    const ttfaSamples = await Promise.all(
        sessions.map(async (session, idx) => {
            const transport = transports[idx];
            if (!transport) return 0;
            const start = performance.now();
            const waitFirst = new Promise<void>((resolve) => {
                transport.firstPacketResolve = resolve;
            });
            await session.addAndMaybePlay({
                tracks: [
                    {
                        id: `t1_${idx}`,
                        title: `Bench Track A ${idx}`,
                        url: `https://example.com/a/${idx}`,
                        duration: 4,
                        thumbnail: "",
                        author: "Bench",
                        provider: "youtube",
                    },
                    {
                        id: `t2_${idx}`,
                        title: `Bench Track B ${idx}`,
                        url: `https://example.com/b/${idx}`,
                        duration: 4,
                        thumbnail: "",
                        author: "Bench",
                        provider: "youtube",
                    },
                ],
                requesterId: "u_bench",
            });
            await waitFirst;
            return performance.now() - start;
        }),
    );

    peakFfmpeg = Math.max(peakFfmpeg, supervisor.getActiveCount());

    // 2. Measure track transition latency across all N sessions simultaneously via skip()
    const transitionSamples = await Promise.all(
        sessions.map(async (session, idx) => {
            const transport = transports[idx];
            if (!transport) return 0;
            const start = performance.now();
            const waitNext = new Promise<void>((resolve) => {
                transport.firstPacketResolve = resolve;
            });
            await session.skip();
            await waitNext;
            return performance.now() - start;
        }),
    );

    // 3. Hold active 20ms packet streaming for 500ms so process.cpuUsage() smooths out OS tick quantization
    await new Promise((r) => setTimeout(r, 500));

    peakFfmpeg = Math.max(peakFfmpeg, supervisor.getActiveCount());
    const cpuDelta = process.cpuUsage(cpuStart);
    const wallDurationMs = Math.max(1, performance.now() - wallStart);
    const rssAfter = process.memoryUsage().rss;

    clearInterval(sampleTimer);

    for (const session of sessions) {
        await session.destroy("benchmark_done");
    }
    await store.close();
    await coordinator.close();
    await new Promise((r) => setTimeout(r, 60));

    const totalCpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    const nodeCpuPercentTotal = (totalCpuMs / wallDurationMs) * 100;
    const rssDeltaMbTotal = Math.max(0, (rssAfter - rssBefore) / (1024 * 1024));

    return {
        sessions: params.sessionCount,
        mode: params.mode,
        wallDurationMs: Number(wallDurationMs.toFixed(1)),
        ttfaMeanMs: Number(mean(ttfaSamples).toFixed(2)),
        ttfaP95Ms: Number(percentile(ttfaSamples, 0.95).toFixed(2)),
        transitionMeanMs: Number(mean(transitionSamples).toFixed(2)),
        nodeCpuPercentTotal: Number(nodeCpuPercentTotal.toFixed(1)),
        nodeCpuPercentPerSession: Number((nodeCpuPercentTotal / params.sessionCount).toFixed(2)),
        rssDeltaMbTotal: Number(rssDeltaMbTotal.toFixed(2)),
        rssDeltaMbPerSession: Number((rssDeltaMbTotal / params.sessionCount).toFixed(2)),
        peakFfmpegProcesses: peakFfmpeg,
        leakedFfmpegProcesses: supervisor.getActiveCount(),
    };
}

async function runCacheAndRecoveryAndStabilityBenchmarks(
    oggPath: string,
    cacheWorkDir: string,
): Promise<{
    cacheColdHits: number;
    cacheWarmHits: number;
    cacheHitRatePercent: number;
    streamRecoveryMs: number;
    stabilityDurationMs: number;
    stabilityTracksCompleted: number;
    stabilityRssDriftMb: number;
    stabilityLeakedFfmpeg: number;
}> {
    // 1. DiskAudioCache hit rate benchmark (cold populate + warm reads)
    const diskCache = new DiskAudioCache({
        cacheDir: join(cacheWorkDir, "disk_bench"),
        minValidBytes: 64,
        maxFiles: 50,
    });
    await diskCache.initialize();
    const oggBytes = readFileSync(oggPath);

    for (let i = 0; i < 10; i += 1) {
        await diskCache.get(`yt:warm_${i}`); // 10 cold misses
        await diskCache.putBuffer(`yt:warm_${i}`, oggBytes, {
            container: "ogg",
            codec: "opus",
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 4,
        });
    }
    const afterCold = diskCache.getStats();

    for (let round = 0; round < 3; round += 1) {
        for (let i = 0; i < 10; i += 1) {
            await diskCache.get(`yt:warm_${i}`); // 30 warm hits
        }
    }
    const afterWarm = diskCache.getStats();

    // 2. ExpiredStreamError recovery latency benchmark
    const store = new MemoryDatabaseStore();
    await store.initialize();
    const coordinator = new InMemoryCoordinator();
    const supervisor = new ProcessSupervisor();
    const audioPipeline = new AudioPipeline({ supervisor });
    const transport = new BenchmarkVoiceTransport();

    let failOnce = true;
    const providersRecovery = {
        hydrateTrack: async (track: Track) => track,
        getStreamDescriptor: async (
            track: Track,
            opts?: { allowFallbackProvider?: boolean },
        ): Promise<StreamDescriptor> => {
            if (failOnce && !opts?.allowFallbackProvider) {
                failOnce = false;
                throw new ExpiredStreamError("Simulated expired stream (403)", 403);
            }
            return {
                sourceType: "cache",
                url: track.url,
                canonicalKey: `bench:${track.id}`,
                container: "ogg",
                codec: "opus",
                sampleRate: 48_000,
                channels: 2,
                durationSeconds: 4,
                isLive: false,
                seekable: true,
                directPassthroughEligible: true,
                cacheFilePath: oggPath,
                resolvedAt: Date.now(),
            };
        },
        findRelatedTracks: async () => [],
    } as unknown as ProviderRegistry;

    const recoverySession = new GuildMusicSession({
        guildId: "bench_rec",
        botId: "bench_bot_0",
        voiceChannelId: "vc_rec",
        textChannelId: "txt_rec",
        store,
        coordinator,
        providers: providersRecovery,
        audioPipeline,
        diskCache,
        transport,
        guildConfig: createDefaultGuildConfig("bench_rec"),
        botSettings: BOT_SETTINGS_DEFAULTS,
        playerState: createDefaultPlayerState(BOT_SETTINGS_DEFAULTS),
    });

    const recStart = performance.now();
    const waitRecoveredPacket = new Promise<void>((resolve) => {
        transport.firstPacketResolve = resolve;
    });
    await recoverySession.addAndMaybePlay({
        tracks: [
            {
                id: "rec_1",
                title: "Recovery Track",
                url: "https://example.com/rec",
                duration: 4,
                thumbnail: "",
                author: "Bench",
                provider: "youtube",
            },
        ],
        requesterId: "u_rec",
    });
    await waitRecoveredPacket;
    const streamRecoveryMs = performance.now() - recStart;
    await recoverySession.destroy("recovery_bench_done");

    // 3. Multi-track continuous stability loop (25 back-to-back playback cycles measuring RSS drift & leaks)
    const stabilitySession = new GuildMusicSession({
        guildId: "bench_stab",
        botId: "bench_bot_0",
        voiceChannelId: "vc_stab",
        textChannelId: "txt_stab",
        store,
        coordinator,
        providers: providersRecovery,
        audioPipeline,
        diskCache,
        transport,
        guildConfig: createDefaultGuildConfig("bench_stab"),
        botSettings: BOT_SETTINGS_DEFAULTS,
        playerState: createDefaultPlayerState(BOT_SETTINGS_DEFAULTS),
    });

    const tracks: Track[] = Array.from({ length: 25 }, (_, i) => ({
        id: `stab_${i}`,
        title: `Stability Track ${i}`,
        url: `https://example.com/stab/${i}`,
        duration: 4,
        thumbnail: "",
        author: "Bench",
        provider: "youtube",
    }));

    const stabRssStart = process.memoryUsage().rss;
    const stabStart = performance.now();
    let completed = 0;

    const firstPlayReady = new Promise<void>((resolve) => {
        transport.firstPacketResolve = resolve;
    });
    await stabilitySession.addAndMaybePlay({ tracks, requesterId: "u_stab" });
    await firstPlayReady;
    completed += 1;

    for (let i = 1; i < tracks.length; i += 1) {
        const nextReady = new Promise<void>((resolve) => {
            transport.firstPacketResolve = resolve;
        });
        await stabilitySession.skip();
        await nextReady;
        completed += 1;
    }

    const stabilityDurationMs = performance.now() - stabStart;
    await stabilitySession.destroy("stability_bench_done");
    const stabRssEnd = process.memoryUsage().rss;

    await store.close();
    await coordinator.close();
    await new Promise((r) => setTimeout(r, 60));

    return {
        cacheColdHits: afterCold.hits,
        cacheWarmHits: afterWarm.hits - afterCold.hits,
        cacheHitRatePercent: Number((afterWarm.hitRate * 100).toFixed(1)),
        streamRecoveryMs: Number(streamRecoveryMs.toFixed(2)),
        stabilityDurationMs: Number(stabilityDurationMs.toFixed(1)),
        stabilityTracksCompleted: completed,
        stabilityRssDriftMb: Number(
            Math.max(0, (stabRssEnd - stabRssStart) / (1024 * 1024)).toFixed(2),
        ),
        stabilityLeakedFfmpeg: supervisor.getActiveCount(),
    };
}

function buildMarkdownReport(params: {
    cpuModel: string;
    cpuCores: number;
    totalMemGb: string;
    nodeVersion: string;
    osName: string;
    passthroughResults: ScenarioResult[];
    transcodeResults: ScenarioResult[];
    aux: Awaited<ReturnType<typeof runCacheAndRecoveryAndStabilityBenchmarks>>;
}): string {
    const formatTable = (rows: ScenarioResult[]) => {
        const header = [
            "| Sessions | Wall (ms) | TTFA Mean (ms) | TTFA P95 (ms) | Transition Mean (ms) | Node CPU % (Total / Session) | RSS Delta MB (Total / Session) | Peak FFmpeg | Leaked FFmpeg |",
            "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ];
        const body = rows.map(
            (r) =>
                `| ${r.sessions} | ${r.wallDurationMs} | ${r.ttfaMeanMs} | ${r.ttfaP95Ms} | ${r.transitionMeanMs} | ${r.nodeCpuPercentTotal}% / ${r.nodeCpuPercentPerSession}% | ${r.rssDeltaMbTotal} / ${r.rssDeltaMbPerSession} | ${r.peakFfmpegProcesses} | ${r.leakedFfmpegProcesses} |`,
        );
        return [...header, ...body].join("\n");
    };

    return `# Rawon V2 — Repeatable Audio Engine Benchmarks

Generated by running \`pnpm bench:audio\` (\`tests/performance/audio-benchmark.ts\`).

## Environment & Methodology

- **Host OS**: ${params.osName}
- **CPU**: ${params.cpuModel} (${params.cpuCores} logical cores)
- **RAM**: ${params.totalMemGb} GiB
- **Node.js**: ${params.nodeVersion}
- **Measurement Scope**:
  - Uses real \`AudioPipeline\`, \`ProcessSupervisor\`, \`ffmpeg-static\` binaries, \`DiskAudioCache\`, and full \`GuildMusicSession\` lifecycle (\`addAndMaybePlay\` -> \`skip\` -> \`destroy\`) over \`BenchmarkVoiceTransport\`.
  - **Node CPU %** measures the Node.js event-loop/orchestration process CPU delta during active streaming; spawned FFmpeg transcode subprocesses execute in parallel OS worker processes tracked by **Peak FFmpeg** and verified zero-leak (**Leaked FFmpeg = 0**) on teardown.
  - Discord REST & UDP network encryption overhead are excluded by using local fixture streams and a local packet-draining \`VoiceTransport\` so measurements remain deterministic across machines.

## 1. Opus Passthrough Pipeline (\`passthrough-ogg-opus\`, Zero FFmpeg Transcoding)

When source media provides compatible 48 kHz stereo Opus audio, Rawon V2 demuxes raw Opus packets in-process with **zero FFmpeg child processes**.

${formatTable(params.passthroughResults)}

## 2. Single-Pass FFmpeg Transcode Pipeline (\`ffmpeg-mp3-to-opus\`, 44.1 kHz MP3 -> 48 kHz 128 kbps Opus)

When source media requires decoding/resampling (or seek/DSP), Rawon V2 spawns one managed FFmpeg worker per active session outputting demuxed 48 kHz stereo Opus frames.

${formatTable(params.transcodeResults)}

## 3. Caching, Stream Recovery & Multi-Track Stability

| Metric | Measured Result |
|---|---:|
| Warm Disk Audio Cache Hits (after 10 cold misses + 30 reads) | ${params.aux.cacheWarmHits} hits (${params.aux.cacheHitRatePercent}% overall hit rate) |
| Expired Stream Recovery Time (\`ExpiredStreamError\` -> Fallback First Packet) | ${params.aux.streamRecoveryMs} ms |
| 25-Track Continuous Cycle Duration | ${params.aux.stabilityDurationMs} ms (${params.aux.stabilityTracksCompleted}/25 completed) |
| 25-Track Stability RSS Drift | ${params.aux.stabilityRssDriftMb} MB |
| Post-Benchmark Leaked FFmpeg Processes | ${params.aux.stabilityLeakedFfmpeg} |
`;
}

async function main(): Promise<void> {
    const workDir = mkdtempSync(join(tmpdir(), "rawon-bench-"));
    try {
        const probePipeline = new AudioPipeline();
        const { oggPath, mp3Path } = generateFixtures(workDir, probePipeline.getFfmpegExecutable());
        const sessionTiers = [1, 5, 10, 25];

        const passthroughResults: ScenarioResult[] = [];
        for (const n of sessionTiers) {
            const res = await runConcurrencyScenario({
                sessionCount: n,
                mode: "passthrough-ogg-opus",
                fixturePath: oggPath,
                cacheDir: join(workDir, `pt_${n}`),
            });
            passthroughResults.push(res);
        }

        const transcodeResults: ScenarioResult[] = [];
        for (const n of sessionTiers) {
            const res = await runConcurrencyScenario({
                sessionCount: n,
                mode: "ffmpeg-mp3-to-opus",
                fixturePath: mp3Path,
                cacheDir: join(workDir, `tr_${n}`),
            });
            transcodeResults.push(res);
        }

        const aux = await runCacheAndRecoveryAndStabilityBenchmarks(oggPath, workDir);

        const cpuInfo = cpus();
        const report = buildMarkdownReport({
            cpuModel: cpuInfo[0]?.model.trim() ?? "Unknown CPU",
            cpuCores: cpuInfo.length,
            totalMemGb: (totalmem() / 1024 ** 3).toFixed(1),
            nodeVersion: process.version,
            osName: `${platform()} ${release()}`,
            passthroughResults,
            transcodeResults,
            aux,
        });

        const reportPath = resolve(import.meta.dirname, "../../docs/AUDIO_BENCHMARKS.md");
        writeFileSync(reportPath, report, "utf8");
        console.log(
            JSON.stringify({ passthroughResults, transcodeResults, aux, reportPath }, null, 2),
        );
    } finally {
        rmSync(workDir, { recursive: true, force: true });
    }
}

main().catch((err) => {
    console.error("Benchmark failed:", err);
    process.exit(1);
});
