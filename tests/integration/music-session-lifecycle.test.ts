import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
    ExpiredStreamError,
    ProviderError,
    type StreamDescriptor,
    type Track,
} from "@rawon/shared";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

function generateOggOpusFixture(targetPath: string, durationSec: number): void {
    const pipeline = new AudioPipeline();
    const res = spawnSync(
        pipeline.getFfmpegExecutable(),
        [
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "libopus",
            "-b:a",
            "96k",
            targetPath,
        ],
        { windowsHide: true },
    );
    if (res.status !== 0) {
        throw new Error(`ffmpeg fixture generation failed: ${res.stderr?.toString()}`);
    }
}

/**
 * Throttled test voice transport that simulates real-time pacing so session controls
 * (pause, resume, seek, volume, filter, skip, previous) never race with instant file EOF.
 */
class ControllableTestVoiceTransport implements VoiceTransport {
    public connectedChannelId: string | null = null;
    private currentPrepared: PreparedAudioStream | null = null;
    private drainTimer: NodeJS.Timeout | null = null;

    public async connect(_guildId: string, channelId: string): Promise<void> {
        this.connectedChannelId = channelId;
    }

    public async disconnect(): Promise<void> {
        await this.stop();
        this.connectedChannelId = null;
    }

    public async playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, error?: Error) => void,
    ): Promise<void> {
        await this.stop();
        this.currentPrepared = prepared;

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

        prepared.stream.once("end", () => finish("ended"));
        prepared.stream.once("error", (err) => finish("error", err));

        // Read modestly every 20ms to mimic Discord 20ms frame pacing without starving tests
        this.drainTimer = setInterval(() => {
            if (!prepared.stream.isPaused()) {
                prepared.stream.read(1024);
            }
        }, 20);
        this.drainTimer.unref?.();
    }

    public async pause(): Promise<boolean> {
        if (!this.currentPrepared) return false;
        this.currentPrepared.stream.pause();
        return true;
    }

    public async resume(): Promise<boolean> {
        if (!this.currentPrepared) return false;
        this.currentPrepared.stream.resume();
        return true;
    }

    public async stop(): Promise<void> {
        if (this.drainTimer) {
            clearInterval(this.drainTimer);
            this.drainTimer = null;
        }
        if (this.currentPrepared) {
            const prev = this.currentPrepared;
            this.currentPrepared = null;
            await prev.cleanup();
        }
    }
}

describe("GuildMusicSession Full Lifecycle & Recovery", () => {
    it("plays via Opus passthrough, handles pause/resume/seek/volume/filter/skip/previous, recovers expired streams, and cleans up processes", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rawon-session-"));
        tempDirs.push(dir);
        const oggPath = join(dir, "sample.ogg");
        generateOggOpusFixture(oggPath, 6);

        const store = new MemoryDatabaseStore();
        await store.initialize();
        const coordinator = new InMemoryCoordinator();
        const supervisor = new ProcessSupervisor();
        const audioPipeline = new AudioPipeline({ supervisor });
        const diskCache = new DiskAudioCache({
            cacheDir: join(dir, "cache"),
            minValidBytes: 64,
        });
        await diskCache.initialize();

        let descriptorAttempts = 0;
        let failFirstAttemptForTrack2 = true;

        const providersStub = {
            hydrateTrack: async (track: Track) => track,
            getStreamDescriptor: async (
                track: Track,
                opts?: { allowFallbackProvider?: boolean },
            ): Promise<StreamDescriptor> => {
                descriptorAttempts += 1;
                if (
                    track.id === "track_2" &&
                    failFirstAttemptForTrack2 &&
                    !opts?.allowFallbackProvider
                ) {
                    failFirstAttemptForTrack2 = false;
                    throw new ExpiredStreamError("Stream URL expired (403)", 403);
                }
                return {
                    sourceType: "cache",
                    url: track.url,
                    canonicalKey: `youtube:${track.id}`,
                    container: "ogg",
                    codec: "opus",
                    sampleRate: 48_000,
                    channels: 2,
                    durationSeconds: track.duration,
                    isLive: false,
                    seekable: true,
                    directPassthroughEligible: true,
                    cacheFilePath: oggPath,
                    resolvedAt: Date.now(),
                };
            },
            findRelatedTracks: async () => [],
        } as unknown as ProviderRegistry;

        const transport = new ControllableTestVoiceTransport();
        const guildConfig = createDefaultGuildConfig("g_session");
        const session = new GuildMusicSession({
            guildId: "g_session",
            botId: "bot_0",
            voiceChannelId: "vc_1",
            textChannelId: "txt_1",
            store,
            coordinator,
            providers: providersStub,
            audioPipeline,
            diskCache,
            transport,
            guildConfig,
            botSettings: BOT_SETTINGS_DEFAULTS,
            playerState: createDefaultPlayerState(BOT_SETTINGS_DEFAULTS),
            emptyVcTimeoutMs: 60,
        });

        const notices: string[] = [];
        session.on("notice", (n: { code: string }) => notices.push(n.code));

        const t1: Track = {
            id: "track_1",
            title: "Fixture One",
            url: "https://example.com/1",
            duration: 6,
            thumbnail: "",
            author: "Test",
            provider: "youtube",
        };
        const t2: Track = {
            id: "track_2",
            title: "Fixture Two",
            url: "https://example.com/2",
            duration: 6,
            thumbnail: "",
            author: "Test",
            provider: "youtube",
        };

        const addRes = await session.addAndMaybePlay({
            tracks: [t1, t2],
            requesterId: "u1",
        });
        expect(addRes.startedImmediately).toBe(true);
        expect(session.status).toBe("playing");
        expect(session.getSnapshot().pipelineMode).toBe("passthrough-ogg-opus");
        expect(supervisor.getActiveCount()).toBe(0); // Passthrough uses zero FFmpeg processes

        // Pause -> Resume
        expect(await session.pause()).toBe(true);
        expect(session.paused).toBe(true);
        expect(await session.resume()).toBe(true);
        expect(session.paused).toBe(false);

        // Seek triggers fast input seek FFmpeg pipeline cleanly
        const seekedTo = await session.seek(2);
        expect(seekedTo).toBe(2);
        expect(session.getSnapshot().pipelineMode).toBe("ffmpeg-ogg-opus");

        // Volume & Filter hot-swap
        expect(await session.setVolume(125)).toBe(125);
        const filterRes = await session.toggleFilter("bassboost");
        expect(filterRes.enabled).toBe(true);

        // Skip to track_2 -> triggers ExpiredStreamError then automatic fallback recovery!
        const skipRes = await session.skip();
        expect(skipRes.next?.track.id).toBe("track_2");
        expect(session.currentTrack?.track.id).toBe("track_2");
        expect(notices).toContain("stream_recovering");
        expect(descriptorAttempts).toBeGreaterThanOrEqual(3);

        // Previous returns to track_1
        const prevRes = await session.previous();
        expect(prevRes?.track.id).toBe("track_1");

        // Empty voice channel auto-pauses and destroys session after emptyVcTimeoutMs (60ms)
        session.handleVoiceMembersUpdate([{ userId: "bot_0", isBot: true, deafened: true }]);
        expect(notices).toContain("empty_vc_countdown");
        await new Promise((r) => setTimeout(r, 130));
        expect(session.isDestroyed).toBe(true);

        // Zero leaked FFmpeg processes after teardown
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("removes permanently failed tracks from queue instead of leaving them orphaned in Up Next", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rawon-session-fail-"));
        tempDirs.push(dir);

        const store = new MemoryDatabaseStore();
        await store.initialize();
        const coordinator = new InMemoryCoordinator();
        const supervisor = new ProcessSupervisor();
        const audioPipeline = new AudioPipeline({ supervisor });
        const providersStub = {
            hydrateTrack: async (track: Track) => track,
            getStreamDescriptor: async () => {
                throw new ProviderError(
                    "YouTube requested bot-verification cookies",
                    "bot_detection",
                    false,
                );
            },
            findRelatedTracks: async () => [],
        } as unknown as ProviderRegistry;

        const transport = new ControllableTestVoiceTransport();
        const guildConfig = createDefaultGuildConfig("g_fail");
        const session = new GuildMusicSession({
            guildId: "g_fail",
            botId: "bot_0",
            voiceChannelId: "vc_fail",
            textChannelId: "txt_fail",
            store,
            coordinator,
            providers: providersStub,
            audioPipeline,
            transport,
            guildConfig,
            botSettings: BOT_SETTINGS_DEFAULTS,
            playerState: createDefaultPlayerState(BOT_SETTINGS_DEFAULTS),
        });

        const notices: string[] = [];
        session.on("notice", (n: { code: string }) => notices.push(n.code));

        try {
            const failingTrack: Track = {
                id: "janice_stfu",
                title: "Janice STFU",
                url: "https://www.youtube.com/watch?v=janice_stfu",
                duration: 238,
                thumbnail: "",
                author: "Janice",
                provider: "youtube",
            };

            await session.addAndMaybePlay({
                tracks: [failingTrack],
                requesterId: "user_1",
            });

            const snapshot = session.getSnapshot();
            expect(notices).toContain("track_failed");
            expect(snapshot.status).toBe("idle");
            expect(snapshot.currentTrack).toBeNull();
            expect(snapshot.queueLength).toBe(0);
            expect(snapshot.upcomingCount).toBe(0);
        } finally {
            await session.destroy();
        }
    });
});
