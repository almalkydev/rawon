export class OperationQueue {
    private tail: Promise<unknown> = Promise.resolve();
    private depth = 0;

    public enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
        this.depth += 1;
        const run = async (): Promise<T> => {
            try {
                return await fn();
            } finally {
                this.depth -= 1;
            }
        };

        const result = this.tail.then(run, run);
        this.tail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    public get pendingCount(): number {
        return this.depth;
    }
}

export class KeyedLockManager {
    private readonly queues = new Map<string, OperationQueue>();

    public async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
        let queue = this.queues.get(key);
        if (!queue) {
            queue = new OperationQueue();
            this.queues.set(key, queue);
        }

        try {
            return await queue.enqueue(fn);
        } finally {
            if (queue.pendingCount === 0) {
                this.queues.delete(key);
            }
        }
    }
}
