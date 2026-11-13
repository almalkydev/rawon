import type { Logger } from "@rawon/shared";

export interface PrefetchTask {
    key: string;
    run: (signal: AbortSignal) => Promise<void>;
}

export class PrefetchCoordinator {
    private readonly maxConcurrency: number;
    private readonly logger?: Logger;
    private activeCount = 0;
    private readonly pendingKeys = new Set<string>();
    private readonly activeControllers = new Map<string, AbortController>();
    private readonly queue: PrefetchTask[] = [];

    public constructor(options: { maxConcurrency?: number; logger?: Logger } = {}) {
        this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 2);
        this.logger = options.logger;
    }

    public schedule(task: PrefetchTask): boolean {
        if (this.pendingKeys.has(task.key) || this.activeControllers.has(task.key)) {
            return false;
        }
        this.pendingKeys.add(task.key);
        this.queue.push(task);
        this.drain();
        return true;
    }

    public cancel(key: string): void {
        this.pendingKeys.delete(key);
        const qIdx = this.queue.findIndex((t) => t.key === key);
        if (qIdx !== -1) {
            this.queue.splice(qIdx, 1);
        }
        const controller = this.activeControllers.get(key);
        if (controller) {
            controller.abort();
            this.activeControllers.delete(key);
        }
    }

    public cancelAll(): void {
        this.pendingKeys.clear();
        this.queue.length = 0;
        for (const controller of this.activeControllers.values()) {
            controller.abort();
        }
        this.activeControllers.clear();
    }

    public getActiveCount(): number {
        return this.activeCount;
    }

    public getPendingCount(): number {
        return this.queue.length;
    }

    private drain(): void {
        while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) break;
            this.pendingKeys.delete(next.key);

            const controller = new AbortController();
            this.activeControllers.set(next.key, controller);
            this.activeCount += 1;

            void next
                .run(controller.signal)
                .catch((err: unknown) => {
                    if (!controller.signal.aborted) {
                        this.logger?.debug({ err, key: next.key }, "Prefetch task failed");
                    }
                })
                .finally(() => {
                    this.activeCount -= 1;
                    this.activeControllers.delete(next.key);
                    this.drain();
                });
        }
    }
}
