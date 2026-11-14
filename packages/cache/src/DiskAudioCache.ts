import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { PassThrough, type Readable } from "node:stream";
import type { Logger } from "@rawon/shared";

export interface CachedAudioMetadata {
    canonicalKey: string;
    hash: string;
    fileName: string;
    container: string;
    codec?: string;
    sampleRate?: number;
    channels?: number;
    durationSeconds?: number;
    byteSize: number;
    createdAt: number;
    lastAccessedAt: number;
}

export interface DiskAudioCacheOptions {
    cacheDir: string;
    maxBytes?: number;
    maxFiles?: number;
    minValidBytes?: number;
    logger?: Logger;
}

export interface DiskAudioCacheStats {
    hits: number;
    misses: number;
    hitRate: number;
    entryCount: number;
    totalBytes: number;
    inFlightCount: number;
    pinnedCount: number;
}

interface InFlightWrite {
    hash: string;
    partPath: string;
    promise: Promise<CachedAudioMetadata | null>;
}

const VALID_CONTAINERS = new Set(["webm", "ogg", "opus", "m4a", "mp4", "mp3", "flac", "wav"]);

export function hashCanonicalAudioKey(canonicalKey: string): string {
    return createHash("sha256").update(canonicalKey).digest("hex").slice(0, 32);
}

function normalizeExtension(container?: string): string {
    const cleaned = (container ?? "webm").toLowerCase().replace(/^\./u, "");
    return VALID_CONTAINERS.has(cleaned) ? cleaned : "bin";
}

export class DiskAudioCache {
    public readonly cacheDir: string;
    private readonly maxBytes: number;
    private readonly maxFiles: number;
    private readonly minValidBytes: number;
    private readonly logger?: Logger;

    private readonly entries = new Map<string, CachedAudioMetadata>(); // keyed by hash
    private readonly pinnedHashes = new Map<string, number>(); // refcount per hash
    private readonly inFlight = new Map<string, InFlightWrite>();

    private hits = 0;
    private misses = 0;
    private initialized = false;

    public constructor(options: DiskAudioCacheOptions) {
        this.cacheDir = options.cacheDir;
        this.maxBytes = Math.max(1024 * 1024, options.maxBytes ?? 500 * 1024 * 1024);
        this.maxFiles = Math.max(5, options.maxFiles ?? 50);
        this.minValidBytes = Math.max(64, options.minValidBytes ?? 2048);
        this.logger = options.logger;

        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    public async initialize(): Promise<void> {
        if (this.initialized) return;
        await mkdir(this.cacheDir, { recursive: true });

        const files = readdirSync(this.cacheDir);
        for (const file of files) {
            const fullPath = join(this.cacheDir, file);
            if (file.endsWith(".part")) {
                await unlink(fullPath).catch(() => undefined);
                continue;
            }
            if (!file.endsWith(".meta.json")) {
                continue;
            }
            try {
                const raw = await readFile(fullPath, "utf8");
                const meta = JSON.parse(raw) as CachedAudioMetadata;
                const dataPath = join(this.cacheDir, meta.fileName);
                const info = await stat(dataPath);
                if (info.isFile() && info.size >= this.minValidBytes) {
                    meta.byteSize = info.size;
                    this.entries.set(meta.hash, meta);
                } else {
                    await unlink(dataPath).catch(() => undefined);
                    await unlink(fullPath).catch(() => undefined);
                }
            } catch {
                await unlink(fullPath).catch(() => undefined);
            }
        }

        await this.evictIfNeeded();
        this.initialized = true;
    }

    public getFilePath(meta: CachedAudioMetadata): string {
        return join(this.cacheDir, meta.fileName);
    }

    public has(canonicalKey: string): boolean {
        const hash = hashCanonicalAudioKey(canonicalKey);
        const meta = this.entries.get(hash);
        if (!meta) return false;
        return existsSync(this.getFilePath(meta));
    }

    public isInProgress(canonicalKey: string): boolean {
        return this.inFlight.has(hashCanonicalAudioKey(canonicalKey));
    }

    public async get(canonicalKey: string): Promise<CachedAudioMetadata | null> {
        await this.initialize();
        const hash = hashCanonicalAudioKey(canonicalKey);
        const meta = this.entries.get(hash);
        if (!meta) {
            this.misses += 1;
            return null;
        }
        const path = this.getFilePath(meta);
        if (!existsSync(path)) {
            this.entries.delete(hash);
            await unlink(join(this.cacheDir, `${hash}.meta.json`)).catch(() => undefined);
            this.misses += 1;
            return null;
        }

        meta.lastAccessedAt = Date.now();
        this.hits += 1;
        void this.writeMetaSidecar(meta).catch(() => undefined);
        return meta;
    }

    public peekWithoutStats(canonicalKey: string): CachedAudioMetadata | null {
        const hash = hashCanonicalAudioKey(canonicalKey);
        const meta = this.entries.get(hash);
        if (!meta) return null;
        return existsSync(this.getFilePath(meta)) ? meta : null;
    }

    public pin(canonicalKey: string): () => void {
        const hash = hashCanonicalAudioKey(canonicalKey);
        this.pinnedHashes.set(hash, (this.pinnedHashes.get(hash) ?? 0) + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const cur = (this.pinnedHashes.get(hash) ?? 1) - 1;
            if (cur <= 0) {
                this.pinnedHashes.delete(hash);
            } else {
                this.pinnedHashes.set(hash, cur);
            }
        };
    }

    public async waitForCompletion(
        canonicalKey: string,
        timeoutMs = 15_000,
    ): Promise<CachedAudioMetadata | null> {
        const hash = hashCanonicalAudioKey(canonicalKey);
        const existing = this.peekWithoutStats(canonicalKey);
        if (existing) {
            return existing;
        }
        const inflight = this.inFlight.get(hash);
        if (!inflight) {
            return null;
        }

        return new Promise<CachedAudioMetadata | null>((resolve) => {
            let settled = false;
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    resolve(null);
                }
            }, timeoutMs);
            timer.unref?.();

            void inflight.promise.then((result) => {
                clearTimeout(timer);
                if (!settled) {
                    settled = true;
                    resolve(result);
                }
            });
        });
    }

    public async cacheFromStream(
        canonicalKey: string,
        sourceStream: Readable,
        metadata: {
            container?: string;
            codec?: string;
            sampleRate?: number;
            channels?: number;
            durationSeconds?: number;
        },
        options: { teeToPlayback?: boolean } = {},
    ): Promise<{ playbackStream?: PassThrough; completion: Promise<CachedAudioMetadata | null> }> {
        await this.initialize();
        const hash = hashCanonicalAudioKey(canonicalKey);

        const existingInFlight = this.inFlight.get(hash);
        if (existingInFlight) {
            return { completion: existingInFlight.promise };
        }

        const ext = normalizeExtension(metadata.container);
        const fileName = `${hash}.${ext}`;
        const finalPath = join(this.cacheDir, fileName);
        const partPath = join(this.cacheDir, `${fileName}.${Date.now()}.part`);

        const playbackStream = options.teeToPlayback
            ? new PassThrough({ highWaterMark: 256 * 1024 })
            : undefined;
        // Prevent uncaught EventEmitter crash if source fails before downstream attaches or after close
        playbackStream?.on("error", () => undefined);
        const fileStream = createWriteStream(partPath);
        let totalBytes = 0;

        const completion = new Promise<CachedAudioMetadata | null>((resolve) => {
            let finished = false;
            let fileFailed = false;
            let waitingFileDrain = false;
            let waitingPlaybackDrain = false;

            const maybeResumeSource = () => {
                if (
                    !waitingFileDrain &&
                    !waitingPlaybackDrain &&
                    !sourceStream.destroyed &&
                    sourceStream.isPaused()
                ) {
                    sourceStream.resume();
                }
            };

            const onFileDrain = () => {
                waitingFileDrain = false;
                maybeResumeSource();
            };

            const onPlaybackDrain = () => {
                waitingPlaybackDrain = false;
                maybeResumeSource();
            };

            const onPlaybackClose = () => {
                waitingPlaybackDrain = false;
                maybeResumeSource();
            };

            const detachDrainListeners = () => {
                fileStream.off("drain", onFileDrain);
                playbackStream?.off("drain", onPlaybackDrain);
                playbackStream?.off("close", onPlaybackClose);
            };

            fileStream.on("drain", onFileDrain);
            playbackStream?.on("drain", onPlaybackDrain);
            playbackStream?.once("close", onPlaybackClose);

            const cleanupFileOnly = async () => {
                fileFailed = true;
                waitingFileDrain = false;
                fileStream.off("drain", onFileDrain);
                fileStream.destroy();
                this.inFlight.delete(hash);
                maybeResumeSource();
                await unlink(partPath).catch(() => undefined);
                if (!finished) {
                    finished = true;
                    resolve(null);
                }
            };

            const cleanupFailure = async () => {
                fileFailed = true;
                waitingFileDrain = false;
                waitingPlaybackDrain = false;
                detachDrainListeners();
                this.inFlight.delete(hash);
                fileStream.destroy();
                maybeResumeSource();
                await unlink(partPath).catch(() => undefined);
                if (!finished) {
                    finished = true;
                    resolve(null);
                }
            };

            sourceStream.on("data", (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (!fileFailed && !fileStream.destroyed && !fileStream.closed) {
                    if (!fileStream.write(chunk) && !waitingFileDrain) {
                        waitingFileDrain = true;
                        sourceStream.pause();
                    }
                }
                if (playbackStream && !playbackStream.destroyed && !playbackStream.writableEnded) {
                    if (!playbackStream.write(chunk) && !waitingPlaybackDrain) {
                        waitingPlaybackDrain = true;
                        sourceStream.pause();
                    }
                }
            });

            sourceStream.once("end", async () => {
                detachDrainListeners();
                if (playbackStream && !playbackStream.destroyed) {
                    playbackStream.end();
                }
                if (finished || fileFailed) return;
                fileStream.end(async () => {
                    finished = true;
                    this.inFlight.delete(hash);
                    try {
                        const info = await stat(partPath);
                        if (info.size < this.minValidBytes || totalBytes < this.minValidBytes) {
                            await unlink(partPath).catch(() => undefined);
                            resolve(null);
                            return;
                        }
                        await rename(partPath, finalPath);
                        const saved: CachedAudioMetadata = {
                            canonicalKey,
                            hash,
                            fileName,
                            container: ext,
                            codec: metadata.codec,
                            sampleRate: metadata.sampleRate,
                            channels: metadata.channels,
                            durationSeconds: metadata.durationSeconds,
                            byteSize: info.size,
                            createdAt: Date.now(),
                            lastAccessedAt: Date.now(),
                        };
                        this.entries.set(hash, saved);
                        await this.writeMetaSidecar(saved);
                        await this.evictIfNeeded();
                        resolve(saved);
                    } catch (err) {
                        this.logger?.debug(
                            { err, canonicalKey },
                            "Failed finalizing audio cache entry",
                        );
                        await unlink(partPath).catch(() => undefined);
                        resolve(null);
                    }
                });
            });

            sourceStream.once("error", (err) => {
                detachDrainListeners();
                if (playbackStream && !playbackStream.destroyed) {
                    playbackStream.destroy(err);
                }
                void cleanupFailure();
            });

            fileStream.once("error", () => {
                void cleanupFileOnly();
            });
        });

        this.inFlight.set(hash, { hash, partPath, promise: completion });
        return { playbackStream, completion };
    }

    public async putBuffer(
        canonicalKey: string,
        data: Buffer,
        metadata: {
            container?: string;
            codec?: string;
            sampleRate?: number;
            channels?: number;
            durationSeconds?: number;
        },
    ): Promise<CachedAudioMetadata | null> {
        await this.initialize();
        if (data.length < this.minValidBytes) {
            return null;
        }
        const hash = hashCanonicalAudioKey(canonicalKey);
        const ext = normalizeExtension(metadata.container);
        const fileName = `${hash}.${ext}`;
        const finalPath = join(this.cacheDir, fileName);
        const partPath = join(this.cacheDir, `${fileName}.${Date.now()}.part`);

        await writeFile(partPath, data);
        await rename(partPath, finalPath);

        const saved: CachedAudioMetadata = {
            canonicalKey,
            hash,
            fileName,
            container: ext,
            codec: metadata.codec,
            sampleRate: metadata.sampleRate,
            channels: metadata.channels,
            durationSeconds: metadata.durationSeconds,
            byteSize: data.length,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
        };
        this.entries.set(hash, saved);
        await this.writeMetaSidecar(saved);
        await this.evictIfNeeded();
        return saved;
    }

    public async deleteEntry(canonicalKey: string): Promise<boolean> {
        const hash = hashCanonicalAudioKey(canonicalKey);
        if ((this.pinnedHashes.get(hash) ?? 0) > 0) {
            return false;
        }
        const meta = this.entries.get(hash);
        if (!meta) return false;
        this.entries.delete(hash);
        await unlink(this.getFilePath(meta)).catch(() => undefined);
        await unlink(join(this.cacheDir, `${hash}.meta.json`)).catch(() => undefined);
        return true;
    }

    public async evictIfNeeded(): Promise<number> {
        let totalBytes = 0;
        for (const meta of this.entries.values()) {
            totalBytes += meta.byteSize;
        }

        if (totalBytes <= this.maxBytes && this.entries.size <= this.maxFiles) {
            return 0;
        }

        const targetBytes = Math.floor(this.maxBytes * 0.7);
        const targetFiles = Math.floor(this.maxFiles * 0.7);

        const sorted = [...this.entries.values()].sort(
            (a, b) => a.lastAccessedAt - b.lastAccessedAt,
        );
        let removedCount = 0;

        for (const meta of sorted) {
            if (totalBytes <= targetBytes && this.entries.size <= targetFiles) {
                break;
            }
            if ((this.pinnedHashes.get(meta.hash) ?? 0) > 0) {
                continue;
            }
            this.entries.delete(meta.hash);
            totalBytes -= meta.byteSize;
            removedCount += 1;
            await unlink(this.getFilePath(meta)).catch(() => undefined);
            await unlink(join(this.cacheDir, `${meta.hash}.meta.json`)).catch(() => undefined);
        }

        return removedCount;
    }

    public async clearUnpinned(): Promise<void> {
        const all = [...this.entries.values()];
        for (const meta of all) {
            if ((this.pinnedHashes.get(meta.hash) ?? 0) > 0) {
                continue;
            }
            this.entries.delete(meta.hash);
            await unlink(this.getFilePath(meta)).catch(() => undefined);
            await unlink(join(this.cacheDir, `${meta.hash}.meta.json`)).catch(() => undefined);
        }
        if (existsSync(this.cacheDir) && this.pinnedHashes.size === 0 && this.inFlight.size === 0) {
            for (const f of readdirSync(this.cacheDir)) {
                if (extname(f) === ".part") {
                    await rm(join(this.cacheDir, f), { force: true }).catch(() => undefined);
                }
            }
        }
    }

    public getStats(): DiskAudioCacheStats {
        let totalBytes = 0;
        for (const meta of this.entries.values()) {
            totalBytes += meta.byteSize;
        }
        const totalLookups = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: totalLookups > 0 ? this.hits / totalLookups : 0,
            entryCount: this.entries.size,
            totalBytes,
            inFlightCount: this.inFlight.size,
            pinnedCount: this.pinnedHashes.size,
        };
    }

    private async writeMetaSidecar(meta: CachedAudioMetadata): Promise<void> {
        const metaPath = join(this.cacheDir, `${meta.hash}.meta.json`);
        const tmpPath = `${metaPath}.tmp`;
        await writeFile(tmpPath, JSON.stringify(meta), "utf8");
        await rename(tmpPath, metaPath);
    }
}
