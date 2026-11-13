import type { Logger } from "@rawon/shared";
import { Redis } from "ioredis";
import { MemoryLruCache } from "./MemoryLruCache.js";

export interface MetadataCacheClient {
    getJson<T>(key: string): Promise<T | null>;
    setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
    delete(key: string): Promise<void>;
    getOrLoad<T>(key: string, ttlSeconds: number, loader: () => Promise<T>): Promise<T>;
    getStats(): { l1HitRate: number; redisConnected: boolean; l2Hits: number; l2Misses: number };
    close(): Promise<void>;
}

export class RedisMetadataCache implements MetadataCacheClient {
    private readonly l1: MemoryLruCache<string, unknown>;
    private redis: Redis | null = null;
    private readonly logger?: Logger;
    private readonly keyPrefix: string;
    private l2Hits = 0;
    private l2Misses = 0;

    public constructor(options: {
        redisUrl?: string | null;
        keyPrefix?: string;
        l1MaxEntries?: number;
        l1TtlMs?: number;
        logger?: Logger;
        redisClient?: Redis;
    }) {
        this.logger = options.logger;
        this.keyPrefix = options.keyPrefix ?? "rawon:meta:";
        this.l1 = new MemoryLruCache({
            maxEntries: options.l1MaxEntries ?? 2000,
            ttlMs: options.l1TtlMs ?? 300_000,
        });

        if (options.redisClient) {
            this.redis = options.redisClient;
        } else if (options.redisUrl) {
            const client = new Redis(options.redisUrl, {
                lazyConnect: true,
                maxRetriesPerRequest: 2,
                enableOfflineQueue: false,
            });
            client.on("error", (err) => {
                this.logger?.debug({ err }, "Redis metadata cache error (falling back to L1)");
            });
            this.redis = client;
        }
    }

    public async connect(): Promise<boolean> {
        if (!this.redis) return false;
        if (this.redis.status === "ready") return true;
        try {
            await this.redis.connect();
            return true;
        } catch (err) {
            this.logger?.warn(
                { err },
                "Could not connect Redis metadata cache; using L1 memory cache",
            );
            return false;
        }
    }

    public async getJson<T>(key: string): Promise<T | null> {
        const l1Val = this.l1.get(key);
        if (l1Val !== undefined) {
            return l1Val as T;
        }

        if (this.redis?.status !== "ready") {
            return null;
        }

        try {
            const raw = await this.redis.get(`${this.keyPrefix}${key}`);
            if (!raw) {
                this.l2Misses += 1;
                return null;
            }
            const parsed = JSON.parse(raw) as T;
            this.l2Hits += 1;
            this.l1.set(key, parsed);
            return parsed;
        } catch {
            return null;
        }
    }

    public async setJson<T>(key: string, value: T, ttlSeconds = 1800): Promise<void> {
        this.l1.set(key, value, ttlSeconds * 1000);
        if (this.redis?.status !== "ready") {
            return;
        }
        try {
            const serialized = JSON.stringify(value);
            await this.redis.set(
                `${this.keyPrefix}${key}`,
                serialized,
                "EX",
                Math.max(1, ttlSeconds),
            );
        } catch {
            // Non-fatal: L1 already holds the entry
        }
    }

    public async delete(key: string): Promise<void> {
        this.l1.delete(key);
        if (this.redis && this.redis.status === "ready") {
            await this.redis.del(`${this.keyPrefix}${key}`).catch(() => undefined);
        }
    }

    public async getOrLoad<T>(
        key: string,
        ttlSeconds: number,
        loader: () => Promise<T>,
    ): Promise<T> {
        const existing = await this.getJson<T>(key);
        if (existing !== null) {
            return existing;
        }
        const loaded = await loader();
        if (loaded !== null && loaded !== undefined) {
            await this.setJson(key, loaded, ttlSeconds);
        }
        return loaded;
    }

    public getStats() {
        return {
            l1HitRate: this.l1.getStats().hitRate,
            redisConnected: this.redis?.status === "ready",
            l2Hits: this.l2Hits,
            l2Misses: this.l2Misses,
        };
    }

    public async close(): Promise<void> {
        if (this.redis) {
            await this.redis.quit().catch(() => {
                this.redis?.disconnect();
            });
        }
    }
}
