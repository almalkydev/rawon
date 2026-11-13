export interface LruCacheOptions {
    maxEntries: number;
    ttlMs?: number;
}

interface CacheEntry<V> {
    value: V;
    expiresAt: number | null;
}

export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    hitRate: number;
}

export class MemoryLruCache<K, V> {
    private readonly map = new Map<K, CacheEntry<V>>();
    private readonly maxEntries: number;
    private readonly ttlMs: number | null;
    private hits = 0;
    private misses = 0;
    private evictions = 0;

    public constructor(options: LruCacheOptions) {
        this.maxEntries = Math.max(1, options.maxEntries);
        this.ttlMs = options.ttlMs && options.ttlMs > 0 ? options.ttlMs : null;
    }

    public get(key: K): V | undefined {
        const entry = this.map.get(key);
        if (!entry) {
            this.misses += 1;
            return undefined;
        }
        if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
            this.map.delete(key);
            this.misses += 1;
            return undefined;
        }
        // Promote to MRU by reinserting
        this.map.delete(key);
        this.map.set(key, entry);
        this.hits += 1;
        return entry.value;
    }

    public set(key: K, value: V, customTtlMs?: number): void {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxEntries) {
            const oldestKey = this.map.keys().next().value;
            if (oldestKey !== undefined) {
                this.map.delete(oldestKey);
                this.evictions += 1;
            }
        }

        const ttl = customTtlMs && customTtlMs > 0 ? customTtlMs : this.ttlMs;
        this.map.set(key, {
            value,
            expiresAt: ttl ? Date.now() + ttl : null,
        });
    }

    public has(key: K): boolean {
        const entry = this.map.get(key);
        if (!entry) return false;
        if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
            this.map.delete(key);
            return false;
        }
        return true;
    }

    public delete(key: K): boolean {
        return this.map.delete(key);
    }

    public clear(): void {
        this.map.clear();
    }

    public getStats(): CacheStats {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            evictions: this.evictions,
            size: this.map.size,
            hitRate: total > 0 ? this.hits / total : 0,
        };
    }
}
