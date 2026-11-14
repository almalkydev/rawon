import { PassThrough } from "node:stream";
import type { PreparedAudioStream } from "@rawon/audio-engine";
import { BOT_SETTINGS_DEFAULTS, createDefaultGuildConfig } from "@rawon/config";
import { MemoryDatabaseStore, PostgresDatabaseStore } from "@rawon/database";
import {
    GuildMusicSession,
    type PlaybackFinishReason,
    type VoiceTransport,
} from "@rawon/music-core";
import { TrackQueue } from "@rawon/queue";
import type { StreamDescriptor, Track } from "@rawon/shared";
import { describe, expect, it, vi } from "vitest";

function makeTrack(id: string, title = `Track ${id}`): Track {
    return {
        id,
        title,
        url: `https://youtube.com/watch?v=${id}`,
        duration: 180,
        thumbnail: "",
        author: "Tester",
        provider: "youtube",
    };
}

class FakeVoiceTransport implements VoiceTransport {
    public playCalls: PreparedAudioStream[] = [];
    public stopCalls = 0;
    public paused = false;
    public finishNextWithErrorOnce = false;
    private finishCb: ((reason: PlaybackFinishReason, err?: Error) => void) | null = null;

    public async connect(_guildId: string, _channelId: string): Promise<void> {}
    public async disconnect(_guildId: string): Promise<void> {}
    public async moveChannel(_guildId: string, _channelId: string): Promise<void> {}
    public async ensureStageSpeaker(_guildId: string, _channelId: string): Promise<void> {}
    public async setVoiceChannelStatus(
        _guildId: string,
        _channelId: string,
        _status: string | null,
    ): Promise<void> {}

    public async playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, err?: Error) => void,
    ): Promise<void> {
        this.playCalls.push(prepared);
        this.paused = false;
        if (this.finishNextWithErrorOnce) {
            this.finishNextWithErrorOnce = false;
            throw new Error("AudioPlayer failed to enter Playing state");
        }
        this.finishCb = onFinished;
    }

    public triggerEnd(reason: PlaybackFinishReason = "ended", err?: Error): void {
        const cb = this.finishCb;
        this.finishCb = null;
        cb?.(reason, err);
    }

    public async pause(): Promise<boolean> {
        if (this.playCalls.length === 0) return false;
        this.paused = true;
        return true;
    }

    public async resume(): Promise<boolean> {
        if (!this.paused) return false;
        this.paused = false;
        return true;
    }

    public async stop(): Promise<void> {
        this.stopCalls += 1;
        this.finishCb = null;
        this.paused = false;
    }
}

function makeSessionDeps(overrides?: {
    store?: MemoryDatabaseStore;
    transport?: FakeVoiceTransport;
    getStreamDescriptor?: (
        track: Track,
        options?: { signal?: AbortSignal },
    ) => Promise<StreamDescriptor>;
}) {
    const store = overrides?.store ?? new MemoryDatabaseStore();
    const transport = overrides?.transport ?? new FakeVoiceTransport();

    const defaultGetDescriptor = async (track: Track): Promise<StreamDescriptor> => ({
        sourceType: "url",
        url: `https://cdn.example.com/${track.id}.webm`,
        canonicalKey: `youtube:${track.id}`,
        container: "webm",
        codec: "opus",
        sampleRate: 48_000,
        channels: 2,
        durationSeconds: track.duration,
        isLive: false,
        seekable: true,
        directPassthroughEligible: true,
        resolvedAt: Date.now(),
    });

    const providers = {
        hydrateTrack: async (t: Track) => t,
        getStreamDescriptor: overrides?.getStreamDescriptor ?? defaultGetDescriptor,
        findRelatedTracks: async () => [],
    };

    const audioPipeline = {
        preparePlaybackStream: async (): Promise<PreparedAudioStream> => {
            const stream = new PassThrough();
            return {
                mode: "passthrough",
                outputEncoding: "opus-packets",
                stream,
                volumeTransform: null,
                cleanup: async () => {
                    stream.destroy();
                },
            };
        },
    };

    return {
        store,
        transport,
        session: new GuildMusicSession({
            guildId: "g-1",
            botId: "b-1",
            voiceChannelId: "vc-1",
            textChannelId: "tc-1",
            store,
            providers: providers as never,
            audioPipeline: audioPipeline as never,
            transport,
            guildConfig: createDefaultGuildConfig("g-1"),
            botSettings: { ...BOT_SETTINGS_DEFAULTS, enableAudioCache: false },
            emptyVcTimeoutMs: 60_000,
        }),
    };
}

describe("Playback & Queue Reliability Regressions", () => {
    it("starts playing newly added tracks after queue previously finished naturally without pause/resume", async () => {
        const { session, transport } = makeSessionDeps();

        const first = await session.addAndMaybePlay({
            tracks: [makeTrack("t1", "Song 1")],
            requesterId: "u1",
        });
        expect(first.startedImmediately).toBe(true);
        expect(session.status).toBe("playing");
        expect(session.currentTrack?.track.id).toBe("t1");

        // Natural end puts session into idle with previous item still retained in queue.items
        transport.triggerEnd("ended");
        await new Promise((r) => setTimeout(r, 20));
        expect(session.status).toBe("idle");
        expect(session.currentTrack).toBeNull();
        expect(session.queue.size).toBe(1);

        // Adding another track must start immediately instead of requiring pause -> resume
        const second = await session.addAndMaybePlay({
            tracks: [makeTrack("t2", "Song 2")],
            requesterId: "u2",
        });
        expect(second.startedImmediately).toBe(true);
        expect(session.status).toBe("playing");
        expect(session.currentTrack?.track.id).toBe("t2");
        expect(transport.playCalls).toHaveLength(2);

        await session.destroy("test_done");
    });

    it("refuses fake pause when idle and recovers cleanly when transport.playStream throws", async () => {
        const transport = new FakeVoiceTransport();
        const { session } = makeSessionDeps({ transport });

        expect(await session.pause()).toBe(false);
        expect(session.paused).toBe(false);

        // Simulate transport failing to enter Playing on first attempt, then recovering on retry
        transport.finishNextWithErrorOnce = true;
        await session.addAndMaybePlay({
            tracks: [makeTrack("t1", "Recoverable Song")],
            requesterId: "u1",
        });

        expect(transport.playCalls).toHaveLength(2);
        expect(session.status).toBe("playing");
        expect(session.currentTrack?.track.id).toBe("t1");

        await session.destroy("test_done");
    });

    it("persists queue immediately, removes exact view item without double-skipping, and keeps paused=false on shutdown", async () => {
        let sawPersistedDuringResolve = false;
        const store = new MemoryDatabaseStore();
        const transport = new FakeVoiceTransport();
        const { session } = makeSessionDeps({
            store,
            transport,
            getStreamDescriptor: async (track) => {
                await new Promise((r) => setTimeout(r, 15));
                const persisted = await store.getQueueSession("g-1", "b-1");
                if (persisted?.currentTrackKey && persisted.tracks.length > 0) {
                    sawPersistedDuringResolve = true;
                }
                return {
                    sourceType: "url",
                    url: `https://cdn.example.com/${track.id}.webm`,
                    canonicalKey: `youtube:${track.id}`,
                    container: "webm",
                    codec: "opus",
                    durationSeconds: 180,
                    isLive: false,
                    seekable: true,
                    directPassthroughEligible: true,
                    resolvedAt: Date.now(),
                };
            },
        });

        await session.addAndMaybePlay({
            tracks: [makeTrack("t1"), makeTrack("t2"), makeTrack("t3")],
            requesterId: "u1",
        });
        expect(sawPersistedDuringResolve).toBe(true);

        // Removing position 1 (current track t1) must play t2 next, NOT skip to t3
        const removed = await session.removeByPositions([1]);
        expect(removed.currentRemoved).toBe(true);
        expect(session.currentTrack?.track.id).toBe("t2");

        // Shutdown while actively playing must keep paused=false for seamless restore
        await session.destroy("shutdown");
        const saved = await store.getQueueSession("g-1", "b-1");
        expect(saved).not.toBeNull();
        expect(saved?.paused).toBe(false);
        expect(saved?.tracks.find((t) => t.key === saved.currentTrackKey)?.track.id).toBe("t2");
        expect(saved?.tracks.map((t) => t.track.id)).toEqual(["t2", "t3"]);

        if (saved) {
            const restoredTransport = new FakeVoiceTransport();
            const restored = makeSessionDeps({ store, transport: restoredTransport }).session;
            await restored.restoreSession(saved);
            expect(restored.status).toBe("playing");
            expect(restored.paused).toBe(false);
            expect(restored.currentTrack?.track.id).toBe("t2");
            await restored.destroy("test_done");
        }
    });

    it("preempts slow stream resolution immediately when skip() is called", async () => {
        let firstAborted = false;
        const { session } = makeSessionDeps({
            getStreamDescriptor: async (track, options) => {
                if (track.id === "slow") {
                    await new Promise<void>((_, reject) => {
                        const timer = setTimeout(() => reject(new Error("timed out")), 5_000);
                        options?.signal?.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(timer);
                                firstAborted = true;
                                reject(new Error("aborted"));
                            },
                            { once: true },
                        );
                    });
                }
                return {
                    sourceType: "url",
                    url: `https://cdn.example.com/${track.id}.webm`,
                    canonicalKey: `youtube:${track.id}`,
                    container: "webm",
                    codec: "opus",
                    durationSeconds: 180,
                    isLive: false,
                    seekable: true,
                    directPassthroughEligible: true,
                    resolvedAt: Date.now(),
                };
            },
        });

        const addPromise = session.addAndMaybePlay({
            tracks: [makeTrack("slow", "Slow Track"), makeTrack("fast", "Fast Track")],
            requesterId: "u1",
        });

        await new Promise((r) => setTimeout(r, 25));
        const t0 = Date.now();
        const skippedResult = await session.skip();
        const elapsedMs = Date.now() - t0;
        await addPromise.catch(() => undefined);

        expect(firstAborted).toBe(true);
        expect(elapsedMs).toBeLessThan(1_000);
        expect(skippedResult.next?.track.id).toBe("fast");
        expect(session.currentTrack?.track.id).toBe("fast");
        expect(session.status).toBe("playing");

        await session.destroy("test_done");
    });

    it("generates unique non-colliding TrackQueue keys after restore()", () => {
        const queue = new TrackQueue({ maxSize: 100 });
        const initial = queue.addMany([{ track: makeTrack("a"), requesterId: "u1" }]);
        const highKey = `${initial[0]?.key.slice(0, -1)}99`;
        queue.restore(
            [
                {
                    key: highKey,
                    index: 1,
                    track: makeTrack("a"),
                    requesterId: "u1",
                    addedAt: Date.now(),
                },
            ],
            highKey,
        );

        const nextAdded = queue.addMany([{ track: makeTrack("b"), requesterId: "u2" }]);
        expect(nextAdded[0]?.key).not.toBe(highKey);
        expect(queue.size).toBe(2);
    });

    it("caches hot PostgresDatabaseStore reads and invalidates immediately on mutations", async () => {
        let embedColor = "7289DA";
        let guildPrefix: string | null = null;
        let rcChannelId: string | null = "ch-1";

        const queryMock = vi.fn(async (sql: string, params?: unknown[]) => {
            const q = sql.toLowerCase();
            if (q.includes("from bot_settings")) {
                return { rows: [{ key: "embed_color", value: embedColor }] };
            }
            if (q.includes("insert into bot_settings")) {
                embedColor = String(params?.[1] ?? "7289DA");
                return { rows: [] };
            }
            if (q.includes("from guilds")) {
                return {
                    rows: [
                        {
                            guild_id: "g-1",
                            prefix: guildPrefix,
                            locale: null,
                            dj_enabled: false,
                            dj_role_id: null,
                            max_queue_size: 500,
                            rc_rate_limit_max: 5,
                            rc_rate_limit_window_ms: 15_000,
                            rc_exclusions_json: {},
                        },
                    ],
                };
            }
            if (q.includes("insert into guilds")) {
                guildPrefix = (params?.[1] as string | null) ?? null;
                return { rows: [] };
            }
            if (q.includes("from request_channels")) {
                return {
                    rows: rcChannelId
                        ? [
                              {
                                  guild_id: "g-1",
                                  bot_id: "b-1",
                                  channel_id: rcChannelId,
                                  message_id: "m-1",
                              },
                          ]
                        : [],
                };
            }
            if (q.includes("delete from request_channels")) {
                rcChannelId = null;
                return { rows: [] };
            }
            return { rows: [] };
        });

        const store = new PostgresDatabaseStore({
            connectionString: "postgres://user:pass@localhost:5432/rawon_test",
        });
        (store as unknown as { pool: { query: typeof queryMock; end: () => Promise<void> } }).pool =
            {
                query: queryMock,
                end: async () => undefined,
            };

        expect((await store.getBotSettings()).embedColor).toBe("7289DA");
        expect((await store.getBotSettings()).embedColor).toBe("7289DA");
        expect(queryMock).toHaveBeenCalledTimes(1);

        await store.setBotSetting("embed_color", "FF0000");
        expect((await store.getBotSettings()).embedColor).toBe("FF0000");
        expect((await store.getBotSettings()).embedColor).toBe("FF0000");
        // 1 initial read + 1 write + 1 refresh read = 3
        expect(queryMock).toHaveBeenCalledTimes(3);

        embedColor = "00FF00";
        store.invalidateBotSettingsCache();
        expect((await store.getBotSettings()).embedColor).toBe("00FF00");
        expect(queryMock).toHaveBeenCalledTimes(4);

        expect((await store.getGuildConfig("g-1")).prefix).toBeNull();
        expect((await store.getGuildConfig("g-1")).prefix).toBeNull();
        expect(queryMock).toHaveBeenCalledTimes(5);

        await store.setGuildPrefix("g-1", "!");
        expect((await store.getGuildConfig("g-1")).prefix).toBe("!");
        expect(queryMock).toHaveBeenCalledTimes(7);

        expect((await store.getRequestChannel("g-1", "b-1"))?.channelId).toBe("ch-1");
        expect((await store.getRequestChannel("g-1", "b-1"))?.channelId).toBe("ch-1");
        expect(queryMock).toHaveBeenCalledTimes(8);

        await store.deleteRequestChannel("g-1", "b-1");
        expect(await store.getRequestChannel("g-1", "b-1")).toBeNull();
        // delete writes once; cache stores null immediately without re-querying
        expect(queryMock).toHaveBeenCalledTimes(9);

        await store.close();
    });
});
