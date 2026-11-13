import { EventEmitter } from "node:events";
import type { AudioPipeline } from "@rawon/audio-engine";
import type { DiskAudioCache, PrefetchCoordinator } from "@rawon/cache";
import type { CoordinatorService, DatabaseStore } from "@rawon/database";
import type { ProviderRegistry } from "@rawon/providers";
import { type BotSettings, KeyedLockManager, type Logger } from "@rawon/shared";
import { GuildMusicSession } from "./GuildMusicSession.js";
import type { VoiceTransport } from "./VoiceTransport.js";

export interface SessionManagerOptions {
    store: DatabaseStore;
    coordinator?: CoordinatorService;
    providers: ProviderRegistry;
    audioPipeline: AudioPipeline;
    diskCache?: DiskAudioCache;
    prefetch?: PrefetchCoordinator;
    logger?: Logger;
    emptyVcTimeoutMs?: number;
}

export class SessionManager extends EventEmitter {
    private readonly sessions = new Map<string, GuildMusicSession>();
    private readonly locks = new KeyedLockManager();
    private readonly store: DatabaseStore;
    private readonly coordinator?: CoordinatorService;
    private readonly providers: ProviderRegistry;
    private readonly audioPipeline: AudioPipeline;
    private readonly diskCache?: DiskAudioCache;
    private readonly prefetch?: PrefetchCoordinator;
    private readonly logger?: Logger;
    private readonly emptyVcTimeoutMs?: number;

    public constructor(options: SessionManagerOptions) {
        super();
        this.store = options.store;
        this.coordinator = options.coordinator;
        this.providers = options.providers;
        this.audioPipeline = options.audioPipeline;
        this.diskCache = options.diskCache;
        this.prefetch = options.prefetch;
        this.logger = options.logger;
        this.emptyVcTimeoutMs = options.emptyVcTimeoutMs;
    }

    private key(guildId: string, botId: string): string {
        return `${guildId}:${botId}`;
    }

    public getSession(guildId: string, botId: string): GuildMusicSession | undefined {
        const session = this.sessions.get(this.key(guildId, botId));
        if (session?.isDestroyed) {
            this.sessions.delete(this.key(guildId, botId));
            return undefined;
        }
        return session;
    }

    public getSessionsForGuild(guildId: string): GuildMusicSession[] {
        const result: GuildMusicSession[] = [];
        for (const session of this.sessions.values()) {
            if (!session.isDestroyed && session.guildId === guildId) {
                result.push(session);
            }
        }
        return result;
    }

    public getSessionsForBot(botId: string): GuildMusicSession[] {
        const result: GuildMusicSession[] = [];
        for (const session of this.sessions.values()) {
            if (!session.isDestroyed && session.botId === botId) {
                result.push(session);
            }
        }
        return result;
    }

    public getAllSessions(): GuildMusicSession[] {
        const result: GuildMusicSession[] = [];
        for (const session of this.sessions.values()) {
            if (!session.isDestroyed) {
                result.push(session);
            }
        }
        return result;
    }

    public getActiveCount(): number {
        return this.getAllSessions().length;
    }

    public async getOrCreateSession(params: {
        guildId: string;
        botId: string;
        voiceChannelId: string;
        textChannelId: string;
        createTransport: () => VoiceTransport;
    }): Promise<GuildMusicSession> {
        const sessionKey = this.key(params.guildId, params.botId);

        return this.locks.withLock(sessionKey, async () => {
            const existing = this.getSession(params.guildId, params.botId);
            if (existing) {
                existing.textChannelId = params.textChannelId;
                return existing;
            }

            const [guildConfig, botSettings, playerState] = await Promise.all([
                this.store.getGuildConfig(params.guildId),
                this.store.getBotSettings(),
                this.store.getPlayerState(params.guildId, params.botId),
            ]);

            if (this.coordinator) {
                const acquired = await this.coordinator.acquireVoiceOwnership(
                    params.guildId,
                    params.voiceChannelId,
                    params.botId,
                    45_000,
                );
                if (!acquired) {
                    const owner = await this.coordinator.getVoiceOwner(
                        params.guildId,
                        params.voiceChannelId,
                    );
                    throw new Error(
                        `Voice channel ${params.voiceChannelId} is currently owned by bot ${owner ?? "another instance"}`,
                    );
                }
            }

            const session = new GuildMusicSession({
                guildId: params.guildId,
                botId: params.botId,
                voiceChannelId: params.voiceChannelId,
                textChannelId: params.textChannelId,
                store: this.store,
                coordinator: this.coordinator,
                providers: this.providers,
                audioPipeline: this.audioPipeline,
                diskCache: this.diskCache,
                prefetch: this.prefetch,
                transport: params.createTransport(),
                guildConfig,
                botSettings,
                playerState,
                logger: this.logger,
                emptyVcTimeoutMs: this.emptyVcTimeoutMs,
            });

            session.once("destroyed", () => {
                if (this.sessions.get(sessionKey) === session) {
                    this.sessions.delete(sessionKey);
                }
            });

            this.sessions.set(sessionKey, session);
            this.emit("sessionCreated", session);
            return session;
        });
    }

    public refreshBotSettings(botSettings: BotSettings): void {
        for (const session of this.sessions.values()) {
            if (!session.isDestroyed) {
                session.updateConfigs({ botSettings });
            }
        }
    }

    public async refreshGuildConfig(guildId: string): Promise<void> {
        const guildConfig = await this.store.getGuildConfig(guildId);
        for (const session of this.getSessionsForGuild(guildId)) {
            session.updateConfigs({ guildConfig });
        }
    }

    public async destroySession(
        guildId: string,
        botId: string,
        reason = "destroyed",
    ): Promise<void> {
        const session = this.getSession(guildId, botId);
        if (!session) return;
        await session.destroy(reason);
        this.sessions.delete(this.key(guildId, botId));
    }

    public async destroyAll(reason = "shutdown"): Promise<void> {
        const all = this.getAllSessions();
        await Promise.allSettled(all.map((s) => s.destroy(reason)));
        this.sessions.clear();
        await this.audioPipeline.supervisor.killAll();
    }

    public getMetrics(): {
        activeSessions: number;
        playingSessions: number;
        activeFfmpegProcesses: number;
        cacheStats: ReturnType<DiskAudioCache["getStats"]> | null;
    } {
        const all = this.getAllSessions();
        return {
            activeSessions: all.length,
            playingSessions: all.filter((s) => s.status === "playing").length,
            activeFfmpegProcesses: this.audioPipeline.supervisor.getActiveCount(),
            cacheStats: this.diskCache?.getStats() ?? null,
        };
    }
}
