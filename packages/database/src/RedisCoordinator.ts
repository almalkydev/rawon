import { EventEmitter } from "node:events";
import type { Logger } from "@rawon/shared";
import { Redis } from "ioredis";
import type {
    BotHeartbeatInfo,
    CoordinatorEvent,
    CoordinatorService,
    RateLimitCheckResult,
} from "./interfaces.js";

const ACQUIRE_OR_RENEW_LOCK_LUA = `
local current = redis.call("GET", KEYS[1])
if not current or current == ARGV[1] then
    redis.call("SET", KEYS[1], ARGV[1], "PX", tonumber(ARGV[2]))
    return 1
end
return 0
`;

const RENEW_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    redis.call("PEXPIRE", KEYS[1], tonumber(ARGV[2]))
    return 1
end
return 0
`;

const RELEASE_LOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
end
return 0
`;

const SLIDING_WINDOW_RATELIMIT_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local max_requests = tonumber(ARGV[3])
local member = ARGV[4]

local cutoff = now - window_ms
redis.call("ZREMRANGEBYSCORE", key, "-inf", cutoff)
local current = tonumber(redis.call("ZCARD", key))

if current >= max_requests then
    local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
    local retry_after = window_ms
    if oldest and oldest[2] then
        retry_after = math.max(1, (tonumber(oldest[2]) + window_ms) - now)
    end
    return {0, 0, retry_after}
end

redis.call("ZADD", key, now, member)
redis.call("PEXPIRE", key, window_ms + 1000)
local remaining = math.max(0, max_requests - (current + 1))
return {1, remaining, 0}
`;

export function selectDeterministicPrimary(
    presentBots: BotHeartbeatInfo[],
    stickyPrimaryId?: string | null,
): string | null {
    if (presentBots.length === 0) return null;
    if (stickyPrimaryId && presentBots.some((b) => b.botId === stickyPrimaryId)) {
        return stickyPrimaryId;
    }
    const sorted = [...presentBots].sort((a, b) => {
        if (a.tokenIndex !== b.tokenIndex) {
            return a.tokenIndex - b.tokenIndex;
        }
        return a.botId.localeCompare(b.botId);
    });
    return sorted[0]?.botId ?? null;
}

export class InMemoryCoordinator implements CoordinatorService {
    private readonly heartbeats = new Map<string, { info: BotHeartbeatInfo; expiresAt: number }>();
    private readonly primaryByGuild = new Map<string, string>();
    private readonly voiceLocks = new Map<string, { botId: string; expiresAt: number }>();
    private readonly rateWindows = new Map<string, number[]>();
    private readonly events = new EventEmitter();

    public async connect(): Promise<void> {}

    public async close(): Promise<void> {
        this.heartbeats.clear();
        this.primaryByGuild.clear();
        this.voiceLocks.clear();
        this.rateWindows.clear();
        this.events.removeAllListeners();
    }

    public async registerBotHeartbeat(info: BotHeartbeatInfo, ttlMs = 15_000): Promise<void> {
        this.heartbeats.set(info.botId, {
            info: { ...info, guildIds: [...info.guildIds] },
            expiresAt: Date.now() + ttlMs,
        });
    }

    public async listActiveBots(): Promise<BotHeartbeatInfo[]> {
        const now = Date.now();
        const result: BotHeartbeatInfo[] = [];
        for (const [botId, entry] of this.heartbeats) {
            if (entry.expiresAt <= now) {
                this.heartbeats.delete(botId);
                continue;
            }
            result.push(entry.info);
        }
        return result;
    }

    public async electPrimaryBot(
        guildId: string,
        presentBots: BotHeartbeatInfo[],
    ): Promise<string | null> {
        const sticky = this.primaryByGuild.get(guildId) ?? null;
        const chosen = selectDeterministicPrimary(presentBots, sticky);
        if (chosen) {
            this.primaryByGuild.set(guildId, chosen);
        } else {
            this.primaryByGuild.delete(guildId);
        }
        return chosen;
    }

    public async acquireVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs = 45_000,
    ): Promise<boolean> {
        const key = `${guildId}:${channelId}`;
        const now = Date.now();
        const existing = this.voiceLocks.get(key);
        if (!existing || existing.expiresAt <= now || existing.botId === botId) {
            this.voiceLocks.set(key, { botId, expiresAt: now + ttlMs });
            return true;
        }
        return false;
    }

    public async renewVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs = 45_000,
    ): Promise<boolean> {
        const key = `${guildId}:${channelId}`;
        const now = Date.now();
        const existing = this.voiceLocks.get(key);
        if (existing && existing.expiresAt > now && existing.botId === botId) {
            existing.expiresAt = now + ttlMs;
            return true;
        }
        return false;
    }

    public async releaseVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
    ): Promise<void> {
        const key = `${guildId}:${channelId}`;
        const existing = this.voiceLocks.get(key);
        if (existing && existing.botId === botId) {
            this.voiceLocks.delete(key);
        }
    }

    public async getVoiceOwner(guildId: string, channelId: string): Promise<string | null> {
        const key = `${guildId}:${channelId}`;
        const existing = this.voiceLocks.get(key);
        if (!existing || existing.expiresAt <= Date.now()) {
            this.voiceLocks.delete(key);
            return null;
        }
        return existing.botId;
    }

    public async checkRateLimit(
        scopeKey: string,
        maxRequests: number,
        windowMs: number,
    ): Promise<RateLimitCheckResult> {
        if (maxRequests <= 0) {
            return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 };
        }
        const now = Date.now();
        const cutoff = now - windowMs;
        const timestamps = (this.rateWindows.get(scopeKey) ?? []).filter((ts) => ts > cutoff);

        if (timestamps.length >= maxRequests) {
            this.rateWindows.set(scopeKey, timestamps);
            const oldest = timestamps[0] ?? now;
            return {
                allowed: false,
                remaining: 0,
                retryAfterMs: Math.max(1, oldest + windowMs - now),
            };
        }

        timestamps.push(now);
        this.rateWindows.set(scopeKey, timestamps);
        return {
            allowed: true,
            remaining: Math.max(0, maxRequests - timestamps.length),
            retryAfterMs: 0,
        };
    }

    public async publishEvent(event: CoordinatorEvent): Promise<void> {
        this.events.emit("event", event);
    }

    public onEvent(handler: (event: CoordinatorEvent) => void): () => void {
        this.events.on("event", handler);
        return () => {
            this.events.off("event", handler);
        };
    }
}

export class RedisCoordinator implements CoordinatorService {
    private readonly redisUrl: string;
    private readonly keyPrefix: string;
    private readonly logger?: Logger;
    private readonly fallback = new InMemoryCoordinator();
    private readonly emitter = new EventEmitter();
    private cmdClient: Redis | null = null;
    private subClient: Redis | null = null;
    private connected = false;
    private seq = 0;

    public constructor(options: {
        redisUrl: string;
        keyPrefix?: string;
        logger?: Logger;
    }) {
        this.redisUrl = options.redisUrl;
        this.keyPrefix = options.keyPrefix ?? "rawon:coord";
        this.logger = options.logger;
    }

    private k(suffix: string): string {
        return `${this.keyPrefix}:${suffix}`;
    }

    public async connect(): Promise<void> {
        if (this.connected) return;
        this.cmdClient = new Redis(this.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            enableOfflineQueue: false,
        });
        this.subClient = new Redis(this.redisUrl, {
            lazyConnect: true,
            maxRetriesPerRequest: 2,
            enableOfflineQueue: false,
        });

        this.cmdClient.on("error", (err) => {
            this.logger?.warn({ err }, "RedisCoordinator command client error");
        });
        this.subClient.on("error", (err) => {
            this.logger?.warn({ err }, "RedisCoordinator subscriber client error");
        });

        await Promise.all([this.cmdClient.connect(), this.subClient.connect()]);

        const eventChannel = this.k("events");
        await this.subClient.subscribe(eventChannel);
        this.subClient.on("message", (channel, raw) => {
            if (channel !== eventChannel) return;
            try {
                const parsed = JSON.parse(raw) as CoordinatorEvent;
                this.emitter.emit("event", parsed);
            } catch (err) {
                this.logger?.warn({ err }, "Malformed coordinator event payload");
            }
        });
        this.connected = true;
    }

    public async close(): Promise<void> {
        this.connected = false;
        this.emitter.removeAllListeners();
        await this.fallback.close();
        if (this.subClient) {
            await this.subClient.quit().catch(() => undefined);
            this.subClient = null;
        }
        if (this.cmdClient) {
            await this.cmdClient.quit().catch(() => undefined);
            this.cmdClient = null;
        }
    }

    public async registerBotHeartbeat(info: BotHeartbeatInfo, ttlMs = 15_000): Promise<void> {
        await this.fallback.registerBotHeartbeat(info, ttlMs);
        if (!this.cmdClient || !this.connected) return;
        try {
            await this.cmdClient.set(this.k(`hb:${info.botId}`), JSON.stringify(info), "PX", ttlMs);
        } catch (err) {
            this.logger?.warn({ err }, "Failed to write Redis bot heartbeat");
        }
    }

    public async listActiveBots(): Promise<BotHeartbeatInfo[]> {
        if (!this.cmdClient || !this.connected) {
            return this.fallback.listActiveBots();
        }
        try {
            const pattern = this.k("hb:*");
            const keys: string[] = [];
            let cursor = "0";
            do {
                const [nextCursor, batch] = await this.cmdClient.scan(
                    cursor,
                    "MATCH",
                    pattern,
                    "COUNT",
                    100,
                );
                cursor = nextCursor;
                keys.push(...batch);
            } while (cursor !== "0");

            if (keys.length === 0) return [];
            const rawValues = await this.cmdClient.mget(keys);
            const bots: BotHeartbeatInfo[] = [];
            for (const raw of rawValues) {
                if (!raw) continue;
                try {
                    bots.push(JSON.parse(raw) as BotHeartbeatInfo);
                } catch {
                    // ignore malformed entry
                }
            }
            return bots;
        } catch (err) {
            this.logger?.warn({ err }, "Redis listActiveBots failed; falling back to local state");
            return this.fallback.listActiveBots();
        }
    }

    public async electPrimaryBot(
        guildId: string,
        presentBots: BotHeartbeatInfo[],
    ): Promise<string | null> {
        if (!this.cmdClient || !this.connected) {
            return this.fallback.electPrimaryBot(guildId, presentBots);
        }
        try {
            const primaryKey = this.k(`primary:${guildId}`);
            const sticky = await this.cmdClient.get(primaryKey);
            const chosen = selectDeterministicPrimary(presentBots, sticky);
            if (chosen) {
                await this.cmdClient.set(primaryKey, chosen, "PX", 120_000);
            } else {
                await this.cmdClient.del(primaryKey);
            }
            return chosen;
        } catch (err) {
            this.logger?.warn({ err }, "Redis electPrimaryBot failed; using local fallback");
            return this.fallback.electPrimaryBot(guildId, presentBots);
        }
    }

    public async acquireVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs = 45_000,
    ): Promise<boolean> {
        if (!this.cmdClient || !this.connected) {
            return this.fallback.acquireVoiceOwnership(guildId, channelId, botId, ttlMs);
        }
        try {
            const res = await this.cmdClient.eval(
                ACQUIRE_OR_RENEW_LOCK_LUA,
                1,
                this.k(`vc:${guildId}:${channelId}`),
                botId,
                String(ttlMs),
            );
            return Number(res) === 1;
        } catch (err) {
            this.logger?.warn({ err }, "Redis acquireVoiceOwnership failed; using fallback");
            return this.fallback.acquireVoiceOwnership(guildId, channelId, botId, ttlMs);
        }
    }

    public async renewVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
        ttlMs = 45_000,
    ): Promise<boolean> {
        if (!this.cmdClient || !this.connected) {
            return this.fallback.renewVoiceOwnership(guildId, channelId, botId, ttlMs);
        }
        try {
            const res = await this.cmdClient.eval(
                RENEW_LOCK_LUA,
                1,
                this.k(`vc:${guildId}:${channelId}`),
                botId,
                String(ttlMs),
            );
            return Number(res) === 1;
        } catch (err) {
            this.logger?.warn({ err }, "Redis renewVoiceOwnership failed");
            return this.fallback.renewVoiceOwnership(guildId, channelId, botId, ttlMs);
        }
    }

    public async releaseVoiceOwnership(
        guildId: string,
        channelId: string,
        botId: string,
    ): Promise<void> {
        await this.fallback.releaseVoiceOwnership(guildId, channelId, botId);
        if (!this.cmdClient || !this.connected) return;
        try {
            await this.cmdClient.eval(
                RELEASE_LOCK_LUA,
                1,
                this.k(`vc:${guildId}:${channelId}`),
                botId,
            );
        } catch (err) {
            this.logger?.warn({ err }, "Redis releaseVoiceOwnership failed");
        }
    }

    public async getVoiceOwner(guildId: string, channelId: string): Promise<string | null> {
        if (!this.cmdClient || !this.connected) {
            return this.fallback.getVoiceOwner(guildId, channelId);
        }
        try {
            return await this.cmdClient.get(this.k(`vc:${guildId}:${channelId}`));
        } catch {
            return this.fallback.getVoiceOwner(guildId, channelId);
        }
    }

    public async checkRateLimit(
        scopeKey: string,
        maxRequests: number,
        windowMs: number,
    ): Promise<RateLimitCheckResult> {
        if (maxRequests <= 0) {
            return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfterMs: 0 };
        }
        if (!this.cmdClient || !this.connected) {
            return this.fallback.checkRateLimit(scopeKey, maxRequests, windowMs);
        }
        try {
            const now = Date.now();
            this.seq = (this.seq + 1) % 1_000_000;
            const member = `${now}:${this.seq}:${Math.random().toString(36).slice(2, 8)}`;
            const res = (await this.cmdClient.eval(
                SLIDING_WINDOW_RATELIMIT_LUA,
                1,
                this.k(`rl:${scopeKey}`),
                String(now),
                String(windowMs),
                String(maxRequests),
                member,
            )) as [number, number, number];
            return {
                allowed: Number(res[0]) === 1,
                remaining: Number(res[1] ?? 0),
                retryAfterMs: Number(res[2] ?? 0),
            };
        } catch (err) {
            this.logger?.warn({ err }, "Redis rate-limit check failed; using local fallback");
            return this.fallback.checkRateLimit(scopeKey, maxRequests, windowMs);
        }
    }

    public async publishEvent(event: CoordinatorEvent): Promise<void> {
        if (!this.cmdClient || !this.connected) {
            await this.fallback.publishEvent(event);
            return;
        }
        try {
            await this.cmdClient.publish(this.k("events"), JSON.stringify(event));
        } catch (err) {
            this.logger?.warn({ err }, "Redis publishEvent failed; emitting locally");
            this.emitter.emit("event", event);
        }
    }

    public onEvent(handler: (event: CoordinatorEvent) => void): () => void {
        const unsubFallback = this.fallback.onEvent(handler);
        this.emitter.on("event", handler);
        return () => {
            unsubFallback();
            this.emitter.off("event", handler);
        };
    }
}
