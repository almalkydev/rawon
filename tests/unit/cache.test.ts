import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DiskAudioCache, MemoryLruCache, PrefetchCoordinator } from "@rawon/cache";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe("MemoryLruCache, DiskAudioCache & PrefetchCoordinator", () => {
    it("tracks hits, misses, LRU eviction, and TTL expiration in MemoryLruCache", async () => {
        const cache = new MemoryLruCache<string, number>({ maxEntries: 2, ttlMs: 5_000 });
        cache.set("a", 1);
        cache.set("b", 2);
        // Promote 'a' so 'b' becomes LRU
        expect(cache.get("a")).toBe(1);
        cache.set("c", 3);

        expect(cache.has("b")).toBe(false);
        expect(cache.get("b")).toBeUndefined();
        expect(cache.get("c")).toBe(3);

        cache.set("short", 99, 25);
        await new Promise((r) => setTimeout(r, 40));
        expect(cache.get("short")).toBeUndefined();

        const stats = cache.getStats();
        expect(stats.hits).toBe(2);
        expect(stats.misses).toBe(2);
        expect(stats.evictions).toBe(2);
        expect(stats.hitRate).toBeCloseTo(0.5);
    });

    it("persists audio buffers via atomic write, protects pinned files from LRU eviction, and records stats", async () => {
        const dir = makeTempDir("rawon-cache-");
        const disk = new DiskAudioCache({
            cacheDir: dir,
            maxBytes: 1024 * 1024,
            maxFiles: 5,
            minValidBytes: 64,
        });
        await disk.initialize();

        const metaOpts = {
            container: "ogg",
            codec: "opus",
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 30,
        };

        await disk.putBuffer("yt:trackA", Buffer.alloc(64, 0x41), metaOpts);
        await new Promise((r) => setTimeout(r, 10));
        await disk.putBuffer("yt:trackB", Buffer.alloc(64, 0x42), metaOpts);
        await new Promise((r) => setTimeout(r, 10));
        await disk.putBuffer("yt:trackC", Buffer.alloc(64, 0x43), metaOpts);
        await new Promise((r) => setTimeout(r, 10));
        await disk.putBuffer("yt:trackD", Buffer.alloc(64, 0x44), metaOpts);
        await new Promise((r) => setTimeout(r, 10));
        await disk.putBuffer("yt:trackE", Buffer.alloc(64, 0x45), metaOpts);
        await new Promise((r) => setTimeout(r, 10));

        // Pin oldest entry (trackA) before inserting 6th entry (> maxFiles=5 triggers eviction to target=3)
        const unpinA = disk.pin("yt:trackA");
        await disk.putBuffer("yt:trackF", Buffer.alloc(64, 0x46), metaOpts);

        expect(await disk.get("yt:trackA")).not.toBeNull();
        expect(await disk.get("yt:trackB")).toBeNull();
        expect(await disk.get("yt:trackF")).not.toBeNull();
        unpinA();

        const stats = disk.getStats();
        expect(stats.hits).toBe(2);
        expect(stats.misses).toBe(1);
        expect(stats.entryCount).toBe(3);
    });

    it("tees live stream to playback and waits for completion before writing sidecar", async () => {
        const dir = makeTempDir("rawon-cache-stream-");
        const disk = new DiskAudioCache({
            cacheDir: dir,
            maxBytes: 1024 * 1024,
            maxFiles: 10,
            minValidBytes: 16,
        });
        await disk.initialize();

        const source = new PassThrough();
        const { playbackStream, completion } = await disk.cacheFromStream(
            "yt:stream1",
            source,
            { container: "webm", codec: "opus", sampleRate: 48_000, channels: 2 },
            { teeToPlayback: true },
        );

        const chunks: Buffer[] = [];
        playbackStream?.on("data", (chunk: Buffer) => chunks.push(chunk));

        const data = Buffer.alloc(64, 0x7f);
        source.end(data);

        const meta = await completion;
        expect(meta?.byteSize).toBe(64);
        expect(Buffer.concat(chunks)).toEqual(data);
        expect(disk.has("yt:stream1")).toBe(true);
    });

    it("keeps tee playbackStream alive and drains source even if fileStream write fails", async () => {
        const dir = makeTempDir("rawon-cache-fail-");
        const disk = new DiskAudioCache({
            cacheDir: dir,
            maxBytes: 1024 * 1024,
            maxFiles: 10,
            minValidBytes: 16,
        });
        await disk.initialize();
        // Remove cacheDir after initialization so createWriteStream fails asynchronously
        rmSync(dir, { recursive: true, force: true });

        const source = new PassThrough();
        const { playbackStream, completion } = await disk.cacheFromStream(
            "yt:stream-fail",
            source,
            { container: "webm", codec: "opus", sampleRate: 48_000, channels: 2 },
            { teeToPlayback: true },
        );

        const chunks: Buffer[] = [];
        const playbackDone = new Promise<void>((resolve, reject) => {
            playbackStream?.on("data", (chunk: Buffer) => chunks.push(chunk));
            playbackStream?.once("end", resolve);
            playbackStream?.once("error", reject);
        });

        const payload = Buffer.alloc(128, 0x3c);
        source.write(payload.subarray(0, 64));
        await new Promise((r) => setTimeout(r, 25));
        source.end(payload.subarray(64));

        const [meta] = await Promise.all([completion, playbackDone]);
        expect(meta).toBeNull();
        expect(Buffer.concat(chunks)).toEqual(payload);
        expect(disk.has("yt:stream-fail")).toBe(false);
    });

    it("bounds concurrent prefetch jobs and supports abort cancellation", async () => {
        const coordinator = new PrefetchCoordinator({ maxConcurrency: 2 });
        let peakActive = 0;
        let currentActive = 0;
        let cancelled = false;

        const makeJob = (key: string, ms: number, checkAbort = false) =>
            coordinator.schedule({
                key,
                run: async (signal) => {
                    currentActive += 1;
                    peakActive = Math.max(peakActive, currentActive);
                    await new Promise<void>((resolve) => {
                        const t = setTimeout(resolve, ms);
                        signal.addEventListener(
                            "abort",
                            () => {
                                clearTimeout(t);
                                if (checkAbort) cancelled = true;
                                resolve();
                            },
                            { once: true },
                        );
                    });
                    currentActive -= 1;
                },
            });

        expect(makeJob("k1", 40)).toBe(true);
        // Duplicate key rejected
        expect(makeJob("k1", 40)).toBe(false);
        expect(makeJob("k2", 40, true)).toBe(true);
        expect(makeJob("k3", 40)).toBe(true);

        await new Promise((r) => setTimeout(r, 15));
        expect(peakActive).toBeLessThanOrEqual(2);
        coordinator.cancel("k2");

        await new Promise((r) => setTimeout(r, 90));
        expect(cancelled).toBe(true);
        expect(coordinator.getActiveCount()).toBe(0);
    });
});
