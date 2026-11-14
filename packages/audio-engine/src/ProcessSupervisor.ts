import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { AudioEngineError, type Logger } from "@rawon/shared";
import ffmpegStatic from "ffmpeg-static";

export interface ManagedProcessInfo {
    id: string;
    command: string;
    pid: number | undefined;
    startedAt: number;
}

export interface SpawnedProcessHandle {
    id: string;
    child: ChildProcess;
    stdout: Readable;
    getStderr: () => string;
    kill: () => Promise<void>;
}

let cachedFfmpegPath: string | null = null;

export function resolveFfmpegExecutable(explicitPath?: string | null): string {
    if (explicitPath?.trim()) {
        return explicitPath.trim();
    }
    if (cachedFfmpegPath) {
        return cachedFfmpegPath;
    }
    const rawExport: unknown = ffmpegStatic;
    if (typeof rawExport === "string" && rawExport.length > 0) {
        cachedFfmpegPath = rawExport;
        return cachedFfmpegPath;
    }
    const defaultVal = (rawExport as { default?: unknown } | null)?.default;
    if (typeof defaultVal === "string" && defaultVal.length > 0) {
        cachedFfmpegPath = defaultVal;
        return cachedFfmpegPath;
    }
    cachedFfmpegPath = "ffmpeg";
    return cachedFfmpegPath;
}

export class ProcessSupervisor {
    private readonly active = new Map<string, SpawnedProcessHandle>();
    private sequence = 0;
    private readonly logger?: Logger;

    public constructor(options: { logger?: Logger } = {}) {
        this.logger = options.logger;
    }

    public spawnManaged(
        command: string,
        args: readonly string[],
        options: {
            pipeInput?: boolean;
            signal?: AbortSignal;
            tag?: string;
        } = {},
    ): SpawnedProcessHandle {
        this.sequence += 1;
        const id = `${options.tag ?? "proc"}_${this.sequence}`;

        const child = spawn(command, [...args], {
            stdio: [options.pipeInput ? "pipe" : "ignore", "pipe", "pipe"],
            windowsHide: true,
        });

        let stderrRing = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => {
            stderrRing = (stderrRing + chunk).slice(-4096);
        });

        const kill = async (): Promise<void> => {
            if (child.exitCode !== null || child.signalCode !== null) {
                this.active.delete(id);
                return;
            }
            return new Promise<void>((resolve) => {
                let settled = false;
                const done = () => {
                    if (settled) return;
                    settled = true;
                    this.active.delete(id);
                    resolve();
                };

                child.once("close", done);
                child.once("error", done);

                try {
                    child.stdin?.end();
                } catch {
                    // ignore
                }
                try {
                    child.kill("SIGTERM");
                } catch {
                    done();
                    return;
                }

                const forceTimer = setTimeout(() => {
                    if (child.exitCode === null && child.signalCode === null) {
                        try {
                            child.kill("SIGKILL");
                        } catch {
                            // ignore
                        }
                    }
                    setTimeout(done, 50).unref?.();
                }, 250);
                forceTimer.unref?.();
            });
        };

        const handle: SpawnedProcessHandle = {
            id,
            child,
            stdout: child.stdout as Readable,
            getStderr: () => stderrRing,
            kill,
        };

        this.active.set(id, handle);

        const cleanup = () => {
            this.active.delete(id);
            options.signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
            void kill();
        };

        if (options.signal) {
            if (options.signal.aborted) {
                void kill();
            } else {
                options.signal.addEventListener("abort", onAbort, { once: true });
            }
        }

        child.once("close", (code, sig) => {
            cleanup();
            if (code !== 0 && code !== null && !options.signal?.aborted) {
                this.logger?.debug(
                    { id, code, sig, stderr: stderrRing.trim() },
                    "Managed child process exited non-zero",
                );
            }
        });

        child.once("error", (err) => {
            cleanup();
            const wrapped = new AudioEngineError(
                `Process ${id} spawn error: ${err.message}`,
                false,
                err,
            );
            this.logger?.error({ err: wrapped, id }, "Managed child process failed to spawn");
            if (child.stdout && !child.stdout.destroyed) {
                child.stdout.destroy(wrapped);
            }
        });

        return handle;
    }

    public getActiveCount(): number {
        return this.active.size;
    }

    public listActive(): ManagedProcessInfo[] {
        return [...this.active.values()].map((h) => ({
            id: h.id,
            command: h.child.spawnfile,
            pid: h.child.pid,
            startedAt: Date.now(),
        }));
    }

    public async killById(id: string): Promise<void> {
        const handle = this.active.get(id);
        if (handle) {
            await handle.kill();
        }
    }

    public async killAll(): Promise<void> {
        const handles = [...this.active.values()];
        await Promise.all(handles.map((h) => h.kill()));
    }
}
