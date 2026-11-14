import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { AudioPipeline, PreparedAudioStream } from "@rawon/audio-engine";
import { type DiskAudioCache, hashCanonicalAudioKey, type PrefetchCoordinator } from "@rawon/cache";
import { createDefaultPlayerState } from "@rawon/config";
import type { CoordinatorService, DatabaseStore } from "@rawon/database";
import type { ProviderRegistry } from "@rawon/providers";
import { AutoplayPlanner, TrackQueue } from "@rawon/queue";
import {
    type AudioQualityProfile,
    type BotSettings,
    type EqualizerBand,
    ExpiredStreamError,
    type FilterName,
    type GuildConfig,
    type Logger,
    type LoopMode,
    OperationQueue,
    type PersistedQueueSession,
    type PlaybackStatus,
    type PlayerState,
    type QueuedTrack,
    type StreamDescriptor,
    type Track,
    ValidationError,
} from "@rawon/shared";
import type { PlaybackFinishReason, VoiceMemberInfo, VoiceTransport } from "./VoiceTransport.js";

function isHlsStreamDescriptor(descriptor: StreamDescriptor): boolean {
    const container = descriptor.container?.toLowerCase();
    if (container === "hls" || container === "m3u8") {
        return true;
    }
    const urlLower = descriptor.url.toLowerCase();
    return urlLower.includes(".m3u8") || urlLower.includes("/hls_playlist/");
}

function isNonAudioContentType(contentType: string | null): boolean {
    if (!contentType) return false;
    const normalized = contentType.toLowerCase();
    return (
        normalized.includes("mpegurl") ||
        normalized.includes("text/html") ||
        normalized.includes("application/xhtml+xml")
    );
}

export interface SessionNotice {
    level: "info" | "warn" | "error";
    code: string;
    key: string;
    params?: Record<string, string | number | boolean>;
}

export interface SessionStateSnapshot {
    guildId: string;
    botId: string;
    voiceChannelId: string;
    textChannelId: string;
    status: PlaybackStatus;
    paused: boolean;
    positionMs: number;
    currentTrack: QueuedTrack | null;
    queueLength: number;
    upcomingCount: number;
    playerState: PlayerState;
    pipelineMode: string | null;
    startedAt: number | null;
}

export interface GuildMusicSessionOptions {
    guildId: string;
    botId: string;
    voiceChannelId: string;
    textChannelId: string;
    store: DatabaseStore;
    coordinator?: CoordinatorService;
    providers: ProviderRegistry;
    audioPipeline: AudioPipeline;
    diskCache?: DiskAudioCache;
    prefetch?: PrefetchCoordinator;
    transport: VoiceTransport;
    guildConfig: GuildConfig;
    botSettings: BotSettings;
    playerState?: PlayerState;
    logger?: Logger;
    emptyVcTimeoutMs?: number;
}

export function getCanonicalTrackKey(track: Pick<Track, "provider" | "id" | "url">): string {
    return `${track.provider}:${track.id || track.url}`;
}

export class GuildMusicSession extends EventEmitter {
    public readonly guildId: string;
    public readonly botId: string;
    public voiceChannelId: string;
    public textChannelId: string;

    private readonly store: DatabaseStore;
    private readonly coordinator?: CoordinatorService;
    private readonly providers: ProviderRegistry;
    private readonly audioPipeline: AudioPipeline;
    private readonly diskCache?: DiskAudioCache;
    private readonly prefetch?: PrefetchCoordinator;
    private readonly transport: VoiceTransport;
    private readonly logger?: Logger;

    public readonly queue: TrackQueue;
    public readonly autoplay = new AutoplayPlanner();
    private readonly ops = new OperationQueue();

    private guildConfig: GuildConfig;
    private botSettings: BotSettings;
    private playerState: PlayerState;
    private readonly emptyVcTimeoutMs: number;

    private statusValue: PlaybackStatus = "idle";
    private pausedValue = false;
    private pipelineMode: string | null = null;
    private currentPrepared: PreparedAudioStream | null = null;
    private activeAbortController: AbortController | null = null;
    private activeCacheUnpin: (() => void) | null = null;
    private activeDescriptorCache = new Map<string, StreamDescriptor>();

    // Accurate monotonic playback timing
    private segmentBaseMs = 0;
    private segmentStartedMonotonicMs: number | null = null;
    private pausedAtPositionMs = 0;

    private playbackGeneration = 0;
    private recoveryAttemptsForTrack = 0;
    private lastRecoveryKey: string | null = null;
    private transportActive = false;
    private persistChain: Promise<void> = Promise.resolve();

    private emptyVcTimer: NodeJS.Timeout | null = null;
    private positionSaveTimer: NodeJS.Timeout | null = null;
    private lockRenewTimer: NodeJS.Timeout | null = null;
    private stateEmitTimer: NodeJS.Timeout | null = null;
    private destroyed = false;

    public constructor(options: GuildMusicSessionOptions) {
        super();
        this.guildId = options.guildId;
        this.botId = options.botId;
        this.voiceChannelId = options.voiceChannelId;
        this.textChannelId = options.textChannelId;
        this.store = options.store;
        this.coordinator = options.coordinator;
        this.providers = options.providers;
        this.audioPipeline = options.audioPipeline;
        this.diskCache = options.diskCache;
        this.prefetch = options.prefetch;
        this.transport = options.transport;
        this.guildConfig = options.guildConfig;
        this.botSettings = options.botSettings;
        this.playerState = options.playerState ?? createDefaultPlayerState(options.botSettings);
        this.logger = options.logger?.child({
            guildId: options.guildId,
            botId: options.botId,
        });
        this.emptyVcTimeoutMs = options.emptyVcTimeoutMs ?? 60_000;

        this.queue = new TrackQueue({ maxSize: options.guildConfig.maxQueueSize });
        this.queue.setLoopMode(this.playerState.loopMode);
        this.queue.setShuffle(this.playerState.shuffle);

        this.startBackgroundTimers();
    }

    public get isDestroyed(): boolean {
        return this.destroyed;
    }

    public get status(): PlaybackStatus {
        return this.statusValue;
    }

    public get paused(): boolean {
        return this.pausedValue;
    }

    public get currentTrack(): QueuedTrack | null {
        return this.queue.current;
    }

    public getPlayerState(): PlayerState {
        return {
            ...this.playerState,
            filters: { ...this.playerState.filters },
            equalizer: [...this.playerState.equalizer],
        };
    }

    public getGuildConfig(): GuildConfig {
        return this.guildConfig;
    }

    public updateConfigs(updates: { guildConfig?: GuildConfig; botSettings?: BotSettings }): void {
        if (updates.guildConfig) {
            this.guildConfig = updates.guildConfig;
            this.queue.maxSize = updates.guildConfig.maxQueueSize;
        }
        if (updates.botSettings) {
            this.botSettings = updates.botSettings;
            if (updates.botSettings.alwaysOn && this.emptyVcTimer) {
                clearTimeout(this.emptyVcTimer);
                this.emptyVcTimer = null;
            }
        }
    }

    public getPositionMs(): number {
        const trackDurationMs = (this.queue.current?.track.duration ?? 0) * 1000;
        let rawMs = this.pausedValue ? this.pausedAtPositionMs : this.segmentBaseMs;
        if (!this.pausedValue && this.segmentStartedMonotonicMs !== null) {
            rawMs += Math.max(0, performance.now() - this.segmentStartedMonotonicMs);
        }
        if (trackDurationMs > 0) {
            return Math.min(Math.max(0, Math.floor(rawMs)), trackDurationMs);
        }
        return Math.max(0, Math.floor(rawMs));
    }

    public getSnapshot(): SessionStateSnapshot {
        return {
            guildId: this.guildId,
            botId: this.botId,
            voiceChannelId: this.voiceChannelId,
            textChannelId: this.textChannelId,
            status: this.statusValue,
            paused: this.pausedValue,
            positionMs: this.getPositionMs(),
            currentTrack: this.queue.current,
            queueLength: this.queue.size,
            upcomingCount: this.queue.getRemainingCount(),
            playerState: this.getPlayerState(),
            pipelineMode: this.pipelineMode,
            startedAt: this.segmentStartedMonotonicMs,
        };
    }

    public async addAndMaybePlay(inputs: {
        tracks: Track[];
        requesterId: string;
        requesterTag?: string;
        playImmediately?: boolean;
    }): Promise<{ added: QueuedTrack[]; startedImmediately: boolean }> {
        if (inputs.playImmediately && inputs.tracks.length > 0 && !this.destroyed) {
            this.preemptActivePlayback();
        }
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const hadActiveCurrent = this.queue.current !== null;
            const wasInactive =
                !hadActiveCurrent || this.statusValue === "idle" || this.statusValue === "stopped";
            const added = this.queue.addMany(
                inputs.tracks.map((track) => ({
                    track,
                    requesterId: inputs.requesterId,
                    requesterTag: inputs.requesterTag,
                })),
            );

            let startedImmediately = false;
            if ((wasInactive || inputs.playImmediately) && added.length > 0) {
                const firstAdded = added[0];
                if (inputs.playImmediately && firstAdded) {
                    this.queue.jumpToKey(firstAdded.key);
                } else if (!this.queue.current && added.length > 0) {
                    this.queue.advance("ended");
                }
                if (this.queue.current) {
                    startedImmediately = true;
                    await this.startCurrentTrack(0);
                }
            } else {
                this.schedulePrefetchUpcoming();
                await this.persistQueueFull();
                this.scheduleStateEmit();
            }

            return { added, startedImmediately };
        });
    }

    public async restoreSession(persisted: PersistedQueueSession): Promise<void> {
        await this.ops.enqueue(async () => {
            this.assertAlive();
            this.voiceChannelId = persisted.voiceChannelId;
            this.textChannelId = persisted.textChannelId;
            this.queue.restore(persisted.tracks, persisted.currentTrackKey);
            this.pausedValue = persisted.paused;
            this.pausedAtPositionMs = persisted.positionMs;
            this.segmentBaseMs = persisted.positionMs;

            if (this.queue.current) {
                await this.transport.connect(this.guildId, this.voiceChannelId);
                await this.transport
                    .ensureStageSpeaker?.(this.guildId, this.voiceChannelId)
                    .catch(() => undefined);

                if (persisted.paused) {
                    this.statusValue = "paused";
                    this.scheduleStateEmit();
                } else {
                    await this.startCurrentTrack(Math.floor(persisted.positionMs / 1000));
                }
            }
        });
    }

    public async pause(): Promise<boolean> {
        return this.ops.enqueue(async () => {
            if (
                this.destroyed ||
                this.pausedValue ||
                !this.queue.current ||
                this.statusValue === "idle" ||
                this.statusValue === "stopped"
            ) {
                return false;
            }
            const currentPos = this.getPositionMs();
            const pausedOk = await this.transport.pause();
            if (!pausedOk && this.statusValue !== "buffering") {
                return false;
            }
            this.pausedAtPositionMs = currentPos;
            this.segmentBaseMs = currentPos;
            this.segmentStartedMonotonicMs = null;
            this.pausedValue = true;
            this.statusValue = "paused";

            await this.enqueuePersist(() =>
                this.store.updateQueuePosition(
                    this.guildId,
                    this.botId,
                    this.queue.currentKey,
                    currentPos,
                    true,
                ),
            );
            this.scheduleStateEmit(true);
            return true;
        });
    }

    public async resume(): Promise<boolean> {
        return this.ops.enqueue(async () => {
            if (this.destroyed || !this.pausedValue || !this.queue.current) {
                return false;
            }

            // If session was restored in paused state without active stream, start from pausedAtPositionMs
            if (!this.currentPrepared) {
                await this.startCurrentTrack(Math.floor(this.pausedAtPositionMs / 1000));
                return true;
            }

            const resumed = await this.transport.resume();
            if (!resumed) {
                await this.startCurrentTrack(Math.floor(this.pausedAtPositionMs / 1000));
                return true;
            }

            this.segmentBaseMs = this.pausedAtPositionMs;
            this.segmentStartedMonotonicMs = performance.now();
            this.pausedValue = false;
            this.statusValue = "playing";

            await this.enqueuePersist(() =>
                this.store.updateQueuePosition(
                    this.guildId,
                    this.botId,
                    this.queue.currentKey,
                    this.pausedAtPositionMs,
                    false,
                ),
            );
            this.scheduleStateEmit(true);
            return true;
        });
    }

    public async skip(): Promise<{ skipped: QueuedTrack | null; next: QueuedTrack | null }> {
        if (!this.destroyed) {
            this.preemptActivePlayback();
        }
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const skipped = this.queue.current;
            if (skipped) {
                this.autoplay.recordPlayed(skipped.track);
            }
            await this.teardownCurrentAudio();

            let next = this.queue.advance("skipped");
            if (!next && this.playerState.autoplay && skipped) {
                next = await this.enqueueAutoplayTrack(skipped.track);
            }

            if (next) {
                await this.startCurrentTrack(0);
            } else {
                await this.enterIdleState();
            }
            return { skipped, next };
        });
    }

    public async skipTo(target: "first" | "last" | number): Promise<QueuedTrack | null> {
        if (!this.destroyed && this.canResolveJumpTarget(target)) {
            this.preemptActivePlayback();
        }
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const targetTrack = this.queue.jumpToTarget(target);
            if (!targetTrack) {
                return null;
            }
            await this.teardownCurrentAudio();
            await this.startCurrentTrack(0);
            return targetTrack;
        });
    }

    public async previous(): Promise<QueuedTrack | null> {
        if (!this.destroyed && this.queue.hasHistory()) {
            this.preemptActivePlayback();
        }
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const prevTrack = this.queue.movePrevious();
            if (!prevTrack) {
                return null;
            }
            await this.teardownCurrentAudio();
            await this.startCurrentTrack(0);
            return prevTrack;
        });
    }

    public async seek(seconds: number): Promise<number> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const current = this.queue.current;
            if (!current) {
                throw new ValidationError("No track is currently playing");
            }
            if (current.track.isLive) {
                throw new ValidationError("Cannot seek in a live stream");
            }
            const clamped = Math.max(
                0,
                current.track.duration > 0
                    ? Math.min(Math.floor(seconds), Math.max(0, current.track.duration - 1))
                    : Math.floor(seconds),
            );
            await this.startCurrentTrack(clamped);
            return clamped;
        });
    }

    public async setVolume(volumePercent: number): Promise<number> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const clamped = Math.max(0, Math.min(200, Math.round(volumePercent)));
            this.playerState = { ...this.playerState, volume: clamped };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);

            if (this.currentPrepared && this.statusValue === "playing") {
                if (this.currentPrepared.volumeTransform) {
                    this.currentPrepared.volumeTransform.setVolumePercent(clamped);
                } else if (this.transport.setInlineVolume?.(clamped)) {
                    // Applied inline
                } else {
                    const posSec = Math.floor(this.getPositionMs() / 1000);
                    await this.startCurrentTrack(posSec);
                }
            }

            this.scheduleStateEmit(true);
            return clamped;
        });
    }

    public async toggleFilter(
        filter: FilterName,
    ): Promise<{ enabled: boolean; filters: PlayerState["filters"] }> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const nextValue = !this.playerState.filters[filter];
            this.playerState = {
                ...this.playerState,
                filters: {
                    ...this.playerState.filters,
                    [filter]: nextValue,
                },
            };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);

            if (this.queue.current && !this.pausedValue && this.currentPrepared) {
                const posSec = Math.floor(this.getPositionMs() / 1000);
                await this.startCurrentTrack(posSec);
            }
            this.scheduleStateEmit(true);
            return { enabled: nextValue, filters: { ...this.playerState.filters } };
        });
    }

    public async resetFilters(): Promise<PlayerState> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.playerState = {
                ...this.playerState,
                filters: {},
                equalizer: [],
            };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);

            if (this.queue.current && !this.pausedValue && this.currentPrepared) {
                const posSec = Math.floor(this.getPositionMs() / 1000);
                await this.startCurrentTrack(posSec);
            }
            this.scheduleStateEmit(true);
            return this.getPlayerState();
        });
    }

    public async setEqualizer(bands: EqualizerBand[]): Promise<PlayerState> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.playerState = { ...this.playerState, equalizer: [...bands] };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            if (this.queue.current && !this.pausedValue && this.currentPrepared) {
                await this.startCurrentTrack(Math.floor(this.getPositionMs() / 1000));
            }
            this.scheduleStateEmit(true);
            return this.getPlayerState();
        });
    }

    public async setQualityProfile(profile: AudioQualityProfile): Promise<PlayerState> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.playerState = { ...this.playerState, qualityProfile: profile };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            if (this.queue.current && !this.pausedValue && this.currentPrepared) {
                await this.startCurrentTrack(Math.floor(this.getPositionMs() / 1000));
            }
            this.scheduleStateEmit(true);
            return this.getPlayerState();
        });
    }

    public async setNormalizeAudio(enabled: boolean): Promise<PlayerState> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.playerState = { ...this.playerState, normalizeAudio: enabled };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            if (this.queue.current && !this.pausedValue && this.currentPrepared) {
                await this.startCurrentTrack(Math.floor(this.getPositionMs() / 1000));
            }
            this.scheduleStateEmit(true);
            return this.getPlayerState();
        });
    }

    public async setLoopMode(mode: LoopMode): Promise<LoopMode> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.queue.setLoopMode(mode);
            this.playerState = { ...this.playerState, loopMode: mode };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            this.scheduleStateEmit(true);
            return mode;
        });
    }

    public async cycleLoopMode(): Promise<LoopMode> {
        const order: LoopMode[] = ["OFF", "QUEUE", "SONG"];
        const next = order[(order.indexOf(this.playerState.loopMode) + 1) % order.length] ?? "OFF";
        return this.setLoopMode(next);
    }

    public async setShuffle(enabled: boolean): Promise<boolean> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.queue.setShuffle(enabled);
            this.playerState = { ...this.playerState, shuffle: enabled };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            this.scheduleStateEmit(true);
            return enabled;
        });
    }

    public async setAutoplay(enabled: boolean): Promise<boolean> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            this.playerState = { ...this.playerState, autoplay: enabled };
            await this.store.savePlayerState(this.guildId, this.botId, this.playerState);
            this.scheduleStateEmit(true);
            return enabled;
        });
    }

    public async removeByPositions(positions1Based: number[]): Promise<{
        removed: QueuedTrack[];
        currentRemoved: boolean;
    }> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const { removed, removedCurrent } = this.queue.removeByPositions(positions1Based);

            if (removedCurrent) {
                await this.teardownCurrentAudio();
                const next = this.queue.current;
                if (next) {
                    await this.startCurrentTrack(0);
                } else {
                    await this.enterIdleState();
                }
            } else {
                await this.persistQueueFull();
                this.scheduleStateEmit();
            }

            return { removed, currentRemoved: removedCurrent };
        });
    }

    public async removeByRequester(requesterId: string): Promise<{
        removedCount: number;
        currentRemoved: boolean;
    }> {
        return this.ops.enqueue(async () => {
            this.assertAlive();
            const { removedCount, removedCurrent } = this.queue.removeByRequester(requesterId);

            if (removedCurrent) {
                await this.teardownCurrentAudio();
                const next = this.queue.current;
                if (next) {
                    await this.startCurrentTrack(0);
                } else {
                    await this.enterIdleState();
                }
            } else {
                await this.persistQueueFull();
                this.scheduleStateEmit();
            }
            return { removedCount, currentRemoved: removedCurrent };
        });
    }

    public async stop(options: { leaveVoice?: boolean; clearQueue?: boolean } = {}): Promise<void> {
        if (!this.destroyed) {
            this.preemptActivePlayback();
        }
        await this.ops.enqueue(async () => {
            if (this.destroyed) return;
            await this.teardownCurrentAudio(true);
            if (options.clearQueue !== false) {
                this.queue.clear();
            }
            this.pausedValue = false;
            this.pausedAtPositionMs = 0;
            this.segmentBaseMs = 0;
            this.segmentStartedMonotonicMs = null;
            this.statusValue = "stopped";
            this.pipelineMode = null;

            await this.transport
                .setVoiceChannelStatus?.(this.guildId, this.voiceChannelId, null)
                .catch(() => undefined);

            if (options.leaveVoice) {
                await this.destroyInternal("stopped_by_user");
            } else {
                await this.enqueuePersist(() =>
                    this.store.deleteQueueSession(this.guildId, this.botId),
                );
                this.scheduleStateEmit(true);
            }
        });
    }

    public handleVoiceMembersUpdate(members: VoiceMemberInfo[]): void {
        if (this.destroyed) return;
        const humanCount = members.filter((m) => !m.isBot).length;

        if (humanCount === 0 && !this.botSettings.alwaysOn) {
            if (!this.emptyVcTimer) {
                this.emit("notice", {
                    level: "info",
                    code: "empty_vc_countdown",
                    key: "music.emptyVcLeaving",
                } satisfies SessionNotice);

                if (this.statusValue === "playing" && !this.pausedValue) {
                    void this.pause();
                }

                this.emptyVcTimer = setTimeout(() => {
                    this.emptyVcTimer = null;
                    if (!this.destroyed && !this.botSettings.alwaysOn) {
                        void this.destroy("empty_vc_timeout");
                    }
                }, this.emptyVcTimeoutMs);
                this.emptyVcTimer.unref?.();
            }
            return;
        }

        if (humanCount > 0 && this.emptyVcTimer) {
            clearTimeout(this.emptyVcTimer);
            this.emptyVcTimer = null;
        }
    }

    public async moveVoiceChannel(newChannelId: string): Promise<void> {
        await this.ops.enqueue(async () => {
            if (this.destroyed || this.voiceChannelId === newChannelId) return;
            const oldChannelId = this.voiceChannelId;
            await this.transport
                .setVoiceChannelStatus?.(this.guildId, oldChannelId, null)
                .catch(() => undefined);

            if (this.coordinator) {
                await this.coordinator.releaseVoiceOwnership(
                    this.guildId,
                    oldChannelId,
                    this.botId,
                );
                await this.coordinator.acquireVoiceOwnership(
                    this.guildId,
                    newChannelId,
                    this.botId,
                    45_000,
                );
            }

            this.voiceChannelId = newChannelId;
            await this.transport.moveChannel?.(this.guildId, newChannelId);
            await this.updateVoiceStatusFromTrack();
            await this.persistQueueFull();
            this.scheduleStateEmit(true);
        });
    }

    public async destroy(reason = "destroyed"): Promise<void> {
        if (!this.destroyed) {
            this.preemptActivePlayback();
        }
        await this.ops.enqueue(async () => {
            await this.destroyInternal(reason);
        });
    }

    private async destroyInternal(reason: string): Promise<void> {
        if (this.destroyed) return;
        this.destroyed = true;
        this.playbackGeneration += 1;

        this.clearBackgroundTimers();
        this.prefetch?.cancelAll();

        // Flush state cleanly if process shutting down; otherwise delete ephemeral queue
        if (reason === "shutdown" && this.queue.size > 0 && this.queue.current !== null) {
            const pos = this.getPositionMs();
            await this.enqueuePersist(() =>
                this.savePersistedQueue(this.queue.currentKey, pos, this.pausedValue),
            );
        } else {
            await this.enqueuePersist(() =>
                this.store.deleteQueueSession(this.guildId, this.botId),
            );
        }

        await this.teardownCurrentAudio(true);
        await this.transport
            .setVoiceChannelStatus?.(this.guildId, this.voiceChannelId, null)
            .catch(() => undefined);
        await this.transport.disconnect(this.guildId).catch(() => undefined);

        if (this.coordinator) {
            await this.coordinator
                .releaseVoiceOwnership(this.guildId, this.voiceChannelId, this.botId)
                .catch(() => undefined);
        }

        this.statusValue = "stopped";
        this.emit("destroyed", { reason });
    }

    private assertAlive(): void {
        if (this.destroyed) {
            throw new ValidationError("Music session has already been destroyed");
        }
    }

    private async startCurrentTrack(seekSeconds: number): Promise<void> {
        const queued = this.queue.current;
        if (!queued || this.destroyed) {
            await this.enterIdleState();
            return;
        }

        const generation = ++this.playbackGeneration;
        await this.teardownCurrentAudio();

        if (this.lastRecoveryKey !== queued.key) {
            this.lastRecoveryKey = queued.key;
            this.recoveryAttemptsForTrack = 0;
        }

        this.statusValue = "buffering";
        this.pausedValue = false;
        this.segmentBaseMs = seekSeconds * 1000;
        this.pausedAtPositionMs = this.segmentBaseMs;
        this.segmentStartedMonotonicMs = null;
        this.scheduleStateEmit(true);

        const abortController = new AbortController();
        this.activeAbortController = abortController;

        try {
            const connectTask = (async () => {
                await this.transport.connect(this.guildId, this.voiceChannelId);
                await this.transport
                    .ensureStageSpeaker?.(this.guildId, this.voiceChannelId)
                    .catch(() => undefined);
            })();

            let durationUpdated = false;
            const resolveTask = (async () => {
                const track =
                    queued.track.provider === "spotify"
                        ? await this.providers.hydrateTrack(queued.track).catch(() => queued.track)
                        : queued.track;
                if (generation !== this.playbackGeneration || this.destroyed) {
                    return null;
                }
                queued.track = track;

                const canonicalKey = getCanonicalTrackKey(track);
                const descriptor = await this.resolvePlayableDescriptor(
                    track,
                    canonicalKey,
                    abortController.signal,
                );
                if (
                    track.duration <= 0 &&
                    descriptor.durationSeconds &&
                    descriptor.durationSeconds > 0
                ) {
                    queued.track = { ...track, duration: descriptor.durationSeconds };
                    durationUpdated = true;
                }
                return { canonicalKey, descriptor };
            })();

            const prepareGroup = Promise.all([connectTask, resolveTask, this.persistQueueFull()]);
            prepareGroup.catch(() => undefined);
            const [, resolved] = await this.raceWithAbort(prepareGroup, abortController.signal);
            if (!resolved || generation !== this.playbackGeneration || this.destroyed) return;
            const { canonicalKey, descriptor } = resolved;
            if (durationUpdated) {
                void this.persistQueueFull();
            }

            let teeSourceStream: Readable | undefined;
            if (descriptor.sourceType === "ytdlp") {
                const spawned = this.providers.ytdlp.spawnAudioStream(descriptor.url, {
                    signal: abortController.signal,
                });
                teeSourceStream = spawned.stream;
            } else if (
                descriptor.directPassthroughEligible &&
                this.botSettings.enableAudioCache &&
                this.diskCache &&
                !descriptor.cacheFilePath &&
                !descriptor.isLive &&
                seekSeconds === 0 &&
                descriptor.sourceType === "url" &&
                !isHlsStreamDescriptor(descriptor)
            ) {
                const teed = await this.tryTeeCacheStream(
                    canonicalKey,
                    descriptor,
                    abortController.signal,
                );
                if (teed) {
                    teeSourceStream = teed;
                }
            }

            if (generation !== this.playbackGeneration || this.destroyed) {
                teeSourceStream?.destroy();
                return;
            }

            // Pin cache entry while playing
            if (descriptor.cacheFilePath && this.diskCache) {
                this.activeCacheUnpin = this.diskCache.pin(canonicalKey);
            }

            const prepared = await this.audioPipeline.preparePlaybackStream({
                descriptor,
                sourceStream: teeSourceStream,
                seekSeconds,
                volumePercent: this.playerState.volume,
                filters: this.playerState.filters,
                equalizer: this.playerState.equalizer,
                normalizeAudio: this.playerState.normalizeAudio,
                qualityProfile: this.playerState.qualityProfile,
                signal: abortController.signal,
            });

            if (generation !== this.playbackGeneration || this.destroyed) {
                await prepared.cleanup();
                return;
            }

            this.currentPrepared = prepared;
            this.pipelineMode = prepared.mode;
            this.segmentBaseMs = seekSeconds * 1000;
            this.segmentStartedMonotonicMs = null;
            this.transportActive = true;

            await this.transport.playStream(prepared, (reason, err) => {
                if (generation !== this.playbackGeneration || this.destroyed) {
                    return;
                }
                void this.onTrackTransportFinished(generation, queued, reason, err);
            });

            if (generation !== this.playbackGeneration || this.destroyed) {
                return;
            }

            this.statusValue = "playing";
            this.segmentBaseMs = seekSeconds * 1000;
            this.segmentStartedMonotonicMs = performance.now();

            this.schedulePrefetchUpcoming();
            this.emit("trackStart", queued);
            this.scheduleStateEmit(true);
            void this.updateVoiceStatusFromTrack();
        } catch (err) {
            if (
                generation !== this.playbackGeneration ||
                this.destroyed ||
                abortController.signal.aborted
            ) {
                return;
            }
            const errorObj = err instanceof Error ? err : new Error(String(err));
            await this.handlePlaybackError(queued, errorObj, seekSeconds);
        }
    }

    private async onTrackTransportFinished(
        generation: number,
        queued: QueuedTrack,
        reason: PlaybackFinishReason,
        err?: Error,
    ): Promise<void> {
        if (generation !== this.playbackGeneration || this.destroyed) return;
        const stoppedAtSec = Math.floor(this.getPositionMs() / 1000);

        await this.ops.enqueue(async () => {
            if (generation !== this.playbackGeneration || this.destroyed) return;

            if (reason !== "stopped") {
                this.transportActive = false;
            }

            if (reason === "error") {
                await this.handlePlaybackError(
                    queued,
                    err ?? new Error("Voice transport stream failure"),
                    stoppedAtSec,
                );
                return;
            }

            if (reason === "stopped") {
                return;
            }

            this.autoplay.recordPlayed(queued.track);
            this.emit("trackEnd", { track: queued, reason });
            await this.teardownCurrentAudio();

            let next = this.queue.advance("ended");
            if (!next && this.playerState.autoplay) {
                next = await this.enqueueAutoplayTrack(queued.track);
            }

            if (next) {
                await this.startCurrentTrack(0);
            } else {
                await this.enterIdleState();
            }
        });
    }

    private async handlePlaybackError(
        queued: QueuedTrack,
        error: Error,
        lastPositionSeconds: number,
    ): Promise<void> {
        const canonicalKey = getCanonicalTrackKey(queued.track);
        this.activeDescriptorCache.delete(canonicalKey);

        const canRecover = this.recoveryAttemptsForTrack < 2 && !(error instanceof ValidationError);

        if (canRecover) {
            this.recoveryAttemptsForTrack += 1;
            this.statusValue = "recovering";
            this.emit("trackError", { track: queued, error, recovering: true });
            this.emit("notice", {
                level: "warn",
                code: "stream_recovering",
                key: "music.recoveringStream",
                params: { title: queued.track.title, attempt: this.recoveryAttemptsForTrack },
            } satisfies SessionNotice);

            this.logger?.warn(
                { err: error, track: queued.track.title, attempt: this.recoveryAttemptsForTrack },
                "Recovering interrupted audio stream",
            );

            try {
                // Force fresh descriptor with provider fallback on retry (and bypass primary if retry #1 still failed)
                const freshDesc = await this.providers.getStreamDescriptor(queued.track, {
                    allowFallbackProvider: true,
                    forceFallbackProvider: this.recoveryAttemptsForTrack >= 2,
                });
                this.activeDescriptorCache.set(canonicalKey, freshDesc);
                await this.startCurrentTrack(lastPositionSeconds);
                return;
            } catch (recoveryErr) {
                this.logger?.warn(
                    { err: recoveryErr, track: queued.track.title },
                    "Stream recovery failed; skipping track",
                );
            }
        }

        this.emit("trackError", { track: queued, error, recovering: false });
        this.emit("notice", {
            level: "error",
            code: "track_failed",
            key: "music.trackLoadFailed",
            params: { title: queued.track.title, reason: error.message },
        } satisfies SessionNotice);

        await this.teardownCurrentAudio();
        const wasCurrent = this.queue.currentKey === queued.key;
        this.queue.removeByKey(queued.key);
        let next = wasCurrent ? this.queue.current : this.queue.advance("skipped");
        if (!next && this.playerState.autoplay) {
            next = await this.enqueueAutoplayTrack(queued.track);
        }
        if (next) {
            await this.startCurrentTrack(0);
        } else {
            await this.enterIdleState();
        }
    }

    private async resolvePlayableDescriptor(
        track: Track,
        canonicalKey: string,
        signal: AbortSignal,
    ): Promise<StreamDescriptor> {
        if (this.botSettings.enableAudioCache && this.diskCache) {
            const cached = await this.diskCache.get(canonicalKey);
            if (cached) {
                return {
                    sourceType: "cache",
                    url: this.diskCache.getFilePath(cached),
                    canonicalKey,
                    container: cached.container,
                    codec: cached.codec,
                    sampleRate: cached.sampleRate,
                    channels: cached.channels,
                    durationSeconds: cached.durationSeconds,
                    isLive: false,
                    seekable: true,
                    directPassthroughEligible:
                        cached.codec === "opus" &&
                        (cached.container === "webm" || cached.container === "ogg"),
                    cacheFilePath: this.diskCache.getFilePath(cached),
                    resolvedAt: cached.createdAt,
                };
            }

            // Wait briefly if a prefetch download is almost done
            if (this.diskCache.isInProgress(canonicalKey)) {
                const completed = await this.diskCache.waitForCompletion(canonicalKey, 250);
                if (completed) {
                    const hit = await this.diskCache.get(canonicalKey);
                    if (hit) {
                        return {
                            sourceType: "cache",
                            url: this.diskCache.getFilePath(hit),
                            canonicalKey,
                            container: hit.container,
                            codec: hit.codec,
                            sampleRate: hit.sampleRate,
                            channels: hit.channels,
                            durationSeconds: hit.durationSeconds,
                            isLive: false,
                            seekable: true,
                            directPassthroughEligible:
                                hit.codec === "opus" &&
                                (hit.container === "webm" || hit.container === "ogg"),
                            cacheFilePath: this.diskCache.getFilePath(hit),
                            resolvedAt: hit.createdAt,
                        };
                    }
                }
            }
        }

        const cachedDesc = this.activeDescriptorCache.get(canonicalKey);
        if (cachedDesc && (!cachedDesc.expiresAt || cachedDesc.expiresAt > Date.now() + 30_000)) {
            return cachedDesc;
        }

        const fresh = await this.providers.getStreamDescriptor(track, { signal });
        this.activeDescriptorCache.set(canonicalKey, fresh);
        return fresh;
    }

    private async tryTeeCacheStream(
        canonicalKey: string,
        descriptor: StreamDescriptor,
        signal: AbortSignal,
    ): Promise<Readable | null> {
        if (
            !this.diskCache ||
            this.diskCache.isInProgress(canonicalKey) ||
            isHlsStreamDescriptor(descriptor)
        ) {
            return null;
        }
        let initialBody: import("node:stream/web").ReadableStream<Uint8Array> | null = null;
        try {
            const initialRes = await this.fetchWithTimeout(
                descriptor.url,
                { headers: descriptor.headers },
                signal,
                8_000,
            );
            if (
                initialRes.status === 401 ||
                initialRes.status === 403 ||
                initialRes.status === 404 ||
                initialRes.status === 410
            ) {
                throw new ExpiredStreamError(
                    `Stream URL expired (HTTP ${initialRes.status})`,
                    initialRes.status,
                );
            }
            if (!initialRes.ok || !initialRes.body) {
                return null;
            }
            if (isNonAudioContentType(initialRes.headers.get("content-type"))) {
                await initialRes.body.cancel().catch(() => undefined);
                return null;
            }

            initialBody = initialRes.body as import("node:stream/web").ReadableStream<Uint8Array>;
            const contentLengthHeader = initialRes.headers.get("content-length");
            const expectedTotalBytes = contentLengthHeader
                ? Number.parseInt(contentLengthHeader, 10)
                : Number.NaN;
            const canResumeRanges = Number.isFinite(expectedTotalBytes) && expectedTotalBytes > 0;

            const out = new PassThrough({ highWaterMark: 256 * 1024 });
            const { playbackStream } = await this.diskCache.cacheFromStream(
                canonicalKey,
                out,
                {
                    container: descriptor.container,
                    codec: descriptor.codec,
                    sampleRate: descriptor.sampleRate,
                    channels: descriptor.channels,
                    durationSeconds: descriptor.durationSeconds,
                },
                { teeToPlayback: true },
            );
            if (!playbackStream) {
                await initialBody.cancel().catch(() => undefined);
                out.destroy();
                return null;
            }

            void this.pumpResumableHttpBody(
                out,
                initialBody,
                descriptor,
                expectedTotalBytes,
                canResumeRanges,
                signal,
            );
            initialBody = null;
            return playbackStream;
        } catch (err) {
            if (initialBody) {
                await initialBody.cancel().catch(() => undefined);
            }
            if (err instanceof ExpiredStreamError) {
                throw err;
            }
            this.logger?.debug({ err, canonicalKey }, "Tee-to-cache fallback to direct pipeline");
            return null;
        }
    }

    private async pumpResumableHttpBody(
        out: PassThrough,
        initialBody: import("node:stream/web").ReadableStream<Uint8Array>,
        descriptor: StreamDescriptor,
        expectedTotalBytes: number,
        canResumeRanges: boolean,
        signal: AbortSignal,
    ): Promise<void> {
        let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = initialBody.getReader();
        let bytesRead = 0;
        let retryAttempt = 0;
        const maxRetries = 3;

        const cancelReader = () => {
            const reader = activeReader;
            activeReader = null;
            if (reader) {
                void reader.cancel().catch(() => undefined);
            }
        };
        const onAbort = () => {
            cancelReader();
            if (!out.destroyed) {
                out.destroy(new Error("Stream aborted"));
            }
        };
        const onOutClose = () => {
            cancelReader();
        };

        signal.addEventListener("abort", onAbort, { once: true });
        out.once("close", onOutClose);

        const waitForDrain = (): Promise<void> =>
            new Promise((resolve) => {
                const cleanup = () => {
                    out.off("drain", cleanup);
                    out.off("close", cleanup);
                    out.off("error", cleanup);
                    resolve();
                };
                out.once("drain", cleanup);
                out.once("close", cleanup);
                out.once("error", cleanup);
            });

        try {
            while (!out.destroyed && !signal.aborted) {
                try {
                    if (!activeReader) break;
                    const { done, value } = await this.readChunkWithTimeout(
                        activeReader,
                        12_000,
                        signal,
                    );
                    if (done) {
                        if (canResumeRanges && bytesRead > 0 && bytesRead < expectedTotalBytes) {
                            throw new Error(
                                `Truncated HTTP stream (${bytesRead}/${expectedTotalBytes} bytes)`,
                            );
                        }
                        if (!out.destroyed && !out.writableEnded) {
                            out.end();
                        }
                        return;
                    }
                    if (!value || value.byteLength === 0) continue;

                    bytesRead += value.byteLength;
                    retryAttempt = 0;
                    if (!out.destroyed && !out.writableEnded) {
                        const ok = out.write(Buffer.from(value));
                        if (!ok && !out.destroyed && !signal.aborted) {
                            await waitForDrain();
                        }
                    }
                } catch (err) {
                    cancelReader();
                    if (signal.aborted || out.destroyed) {
                        return;
                    }
                    const canRetry =
                        canResumeRanges &&
                        bytesRead > 0 &&
                        bytesRead < expectedTotalBytes &&
                        retryAttempt < maxRetries;
                    if (!canRetry) {
                        if (!out.destroyed) {
                            out.destroy(err instanceof Error ? err : new Error(String(err)));
                        }
                        return;
                    }

                    retryAttempt += 1;
                    await new Promise((resolve) => setTimeout(resolve, 150 * retryAttempt));
                    if (signal.aborted || out.destroyed) {
                        return;
                    }

                    const resumeRes = await this.fetchWithTimeout(
                        descriptor.url,
                        {
                            headers: {
                                ...descriptor.headers,
                                Range: `bytes=${bytesRead}-`,
                            },
                        },
                        signal,
                        8_000,
                    );
                    if (
                        resumeRes.status === 401 ||
                        resumeRes.status === 403 ||
                        resumeRes.status === 404 ||
                        resumeRes.status === 410
                    ) {
                        throw new ExpiredStreamError(
                            `Stream URL expired on resume (HTTP ${resumeRes.status})`,
                            resumeRes.status,
                        );
                    }
                    if (resumeRes.status !== 206 || !resumeRes.body) {
                        throw new Error(`Unexpected status ${resumeRes.status} on Range resume`);
                    }
                    activeReader = (
                        resumeRes.body as import("node:stream/web").ReadableStream<Uint8Array>
                    ).getReader();
                }
            }
        } catch (err) {
            if (!out.destroyed) {
                out.destroy(err instanceof Error ? err : new Error(String(err)));
            }
        } finally {
            signal.removeEventListener("abort", onAbort);
            out.off("close", onOutClose);
            cancelReader();
        }
    }

    private schedulePrefetchUpcoming(): void {
        if (!this.prefetch) {
            return;
        }
        const diskCache = this.botSettings.enableAudioCache ? this.diskCache : undefined;
        const upcoming = this.queue.getUpcomingTracks(2);
        for (const item of upcoming) {
            const canonicalKey = getCanonicalTrackKey(item.track);
            const existingDesc = this.activeDescriptorCache.get(canonicalKey);
            const hasFreshDescriptor = Boolean(
                existingDesc &&
                    (!existingDesc.expiresAt || existingDesc.expiresAt > Date.now() + 30_000),
            );
            const hasDiskCache = Boolean(
                diskCache &&
                    (diskCache.peekWithoutStats(canonicalKey) ||
                        diskCache.isInProgress(canonicalKey)),
            );
            if (item.track.isLive || (hasFreshDescriptor && (!diskCache || hasDiskCache))) {
                continue;
            }

            const taskKey = hashCanonicalAudioKey(canonicalKey);
            this.prefetch.schedule({
                key: taskKey,
                run: async (signal) => {
                    let track = item.track;
                    if (track.provider === "spotify") {
                        track = await this.providers.hydrateTrack(track).catch(() => track);
                        item.track = track;
                    }
                    let desc = this.activeDescriptorCache.get(canonicalKey);
                    if (!desc || (desc.expiresAt && desc.expiresAt <= Date.now() + 30_000)) {
                        desc = await this.providers.getStreamDescriptor(track, { signal });
                        this.activeDescriptorCache.set(canonicalKey, desc);
                        if (
                            track.duration <= 0 &&
                            desc.durationSeconds &&
                            desc.durationSeconds > 0
                        ) {
                            item.track = { ...track, duration: desc.durationSeconds };
                        }
                    }
                    if (
                        !diskCache ||
                        hasDiskCache ||
                        desc.isLive ||
                        desc.sourceType !== "url" ||
                        isHlsStreamDescriptor(desc)
                    ) {
                        return;
                    }

                    const res = await fetch(desc.url, { headers: desc.headers, signal });
                    if (!res.ok || !res.body) return;
                    if (isNonAudioContentType(res.headers.get("content-type"))) {
                        await res.body.cancel().catch(() => undefined);
                        return;
                    }
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
        }
    }

    private async enqueueAutoplayTrack(seedTrack: Track): Promise<QueuedTrack | null> {
        const excludeIds = this.autoplay.getExcludedIds(this.queue.getAll().map((q) => q.track.id));
        const nextTrack = await this.autoplay
            .selectNext(
                seedTrack,
                (seed, exclude) => this.providers.findRelatedTracks(seed, exclude),
                this.queue.getAll().map((q) => q.track.id),
            )
            .catch(() => null);

        if (!nextTrack || excludeIds.has(nextTrack.id)) {
            return null;
        }
        this.queue.add({
            track: nextTrack,
            requesterId: this.botId,
            requesterTag: "Autoplay",
        });
        return this.queue.advance("ended");
    }

    private async teardownCurrentAudio(forceTransportStop = false): Promise<void> {
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
        if (this.activeCacheUnpin) {
            this.activeCacheUnpin();
            this.activeCacheUnpin = null;
        }
        const tasks: Promise<unknown>[] = [];
        if (this.currentPrepared) {
            const p = this.currentPrepared;
            this.currentPrepared = null;
            tasks.push(p.cleanup().catch(() => undefined));
        }
        if (this.transportActive || forceTransportStop) {
            this.transportActive = false;
            tasks.push(this.transport.stop().catch(() => undefined));
        }
        if (tasks.length > 0) {
            await Promise.all(tasks);
        }
    }

    private async enterIdleState(): Promise<void> {
        this.statusValue = "idle";
        this.pausedValue = false;
        this.pipelineMode = null;
        this.segmentBaseMs = 0;
        this.pausedAtPositionMs = 0;
        this.segmentStartedMonotonicMs = null;

        await this.transport
            .setVoiceChannelStatus?.(this.guildId, this.voiceChannelId, null)
            .catch(() => undefined);
        await this.enqueuePersist(() => this.store.deleteQueueSession(this.guildId, this.botId));
        this.scheduleStateEmit(true);
    }

    private async updateVoiceStatusFromTrack(): Promise<void> {
        const cur = this.queue.current;
        if (!cur) return;
        const label = cur.track.author
            ? `🎵 ${cur.track.title} — ${cur.track.author}`
            : `🎵 ${cur.track.title}`;
        const truncated = label.length > 500 ? `${label.slice(0, 497)}...` : label;
        await this.transport
            .setVoiceChannelStatus?.(this.guildId, this.voiceChannelId, truncated)
            .catch(() => undefined);
    }

    private async persistQueueFull(): Promise<void> {
        if (this.destroyed) return;
        const currentTrackKey = this.queue.currentKey;
        const positionMs = this.getPositionMs();
        const paused = this.pausedValue;
        await this.enqueuePersist(() =>
            this.savePersistedQueue(currentTrackKey, positionMs, paused),
        );
    }

    private async savePersistedQueue(
        currentTrackKey: string | null,
        positionMs: number,
        paused: boolean,
    ): Promise<void> {
        const snap = this.queue.snapshot();
        await this.store.saveQueueSession({
            guildId: this.guildId,
            botId: this.botId,
            voiceChannelId: this.voiceChannelId,
            textChannelId: this.textChannelId,
            currentTrackKey,
            positionMs,
            paused,
            tracks: snap.tracks,
        });
    }

    private scheduleStateEmit(immediate = false): void {
        if (this.destroyed) return;
        if (immediate) {
            if (this.stateEmitTimer) {
                clearTimeout(this.stateEmitTimer);
                this.stateEmitTimer = null;
            }
            this.emit("stateUpdate", this.getSnapshot());
            return;
        }
        if (this.stateEmitTimer) return;
        this.stateEmitTimer = setTimeout(() => {
            this.stateEmitTimer = null;
            if (!this.destroyed) {
                this.emit("stateUpdate", this.getSnapshot());
            }
        }, 300);
        this.stateEmitTimer.unref?.();
    }

    private startBackgroundTimers(): void {
        // Persist playback position every 10 seconds while playing
        this.positionSaveTimer = setInterval(() => {
            if (
                !this.destroyed &&
                this.statusValue === "playing" &&
                this.queue.current &&
                !this.pausedValue
            ) {
                const trackKey = this.queue.currentKey;
                const posMs = this.getPositionMs();
                void this.enqueuePersist(() =>
                    this.store.updateQueuePosition(
                        this.guildId,
                        this.botId,
                        trackKey,
                        posMs,
                        false,
                    ),
                );
            }
        }, 10_000);
        this.positionSaveTimer.unref?.();

        // Renew Redis VC ownership lock every 15s (45s TTL)
        if (this.coordinator) {
            this.lockRenewTimer = setInterval(() => {
                if (!this.destroyed && this.coordinator) {
                    void this.coordinator
                        .renewVoiceOwnership(this.guildId, this.voiceChannelId, this.botId, 45_000)
                        .catch(() => undefined);
                }
            }, 15_000);
            this.lockRenewTimer.unref?.();
        }
    }

    private clearBackgroundTimers(): void {
        if (this.emptyVcTimer) {
            clearTimeout(this.emptyVcTimer);
            this.emptyVcTimer = null;
        }
        if (this.positionSaveTimer) {
            clearInterval(this.positionSaveTimer);
            this.positionSaveTimer = null;
        }
        if (this.lockRenewTimer) {
            clearInterval(this.lockRenewTimer);
            this.lockRenewTimer = null;
        }
        if (this.stateEmitTimer) {
            clearTimeout(this.stateEmitTimer);
            this.stateEmitTimer = null;
        }
    }

    private preemptActivePlayback(): void {
        this.playbackGeneration += 1;
        if (this.activeAbortController) {
            this.activeAbortController.abort();
            this.activeAbortController = null;
        }
    }

    private canResolveJumpTarget(target: "first" | "last" | number): boolean {
        const view = this.queue.getView();
        if (view.length === 0) {
            return false;
        }
        if (target === "first" || target === "last") {
            return true;
        }
        return Number.isInteger(target) && target >= 1 && target <= view.length;
    }

    private enqueuePersist(task: () => Promise<void>): Promise<void> {
        const next = this.persistChain.then(task, task);
        this.persistChain = next.catch((err) => {
            this.logger?.debug({ err }, "Failed persisting queue session");
        });
        return this.persistChain;
    }

    private async raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
        if (signal.aborted) {
            throw new Error("Playback operation aborted");
        }
        return await new Promise<T>((resolve, reject) => {
            const onAbort = () => {
                signal.removeEventListener("abort", onAbort);
                reject(new Error("Playback operation aborted"));
            };
            signal.addEventListener("abort", onAbort, { once: true });
            promise.then(
                (val) => {
                    signal.removeEventListener("abort", onAbort);
                    resolve(val);
                },
                (err) => {
                    signal.removeEventListener("abort", onAbort);
                    reject(err);
                },
            );
        });
    }

    private async fetchWithTimeout(
        url: string,
        init: RequestInit,
        signal: AbortSignal,
        timeoutMs: number,
    ): Promise<Response> {
        if (signal.aborted) {
            throw new Error("Stream aborted");
        }
        const timeoutController = new AbortController();
        const onParentAbort = () => {
            timeoutController.abort(signal.reason);
        };
        signal.addEventListener("abort", onParentAbort, { once: true });
        const timer = setTimeout(() => {
            timeoutController.abort(
                new Error(`HTTP stream connect timed out after ${timeoutMs}ms`),
            );
        }, timeoutMs);
        timer.unref?.();
        try {
            return await fetch(url, {
                ...init,
                signal: timeoutController.signal,
            });
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onParentAbort);
        }
    }

    private async readChunkWithTimeout(
        reader: ReadableStreamDefaultReader<Uint8Array>,
        timeoutMs: number,
        signal: AbortSignal,
    ): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
        if (signal.aborted) {
            throw new Error("Stream aborted");
        }
        return await new Promise<
            Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>
        >((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", onAbort);
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error("Stream aborted"));
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(`HTTP audio stream read stalled after ${timeoutMs}ms`));
            }, timeoutMs);
            timer.unref?.();
            signal.addEventListener("abort", onAbort, { once: true });

            reader.read().then(
                (result) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    resolve(result);
                },
                (err) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    reject(err);
                },
            );
        });
    }
}
