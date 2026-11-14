import { EventEmitter } from "node:events";
import { type LoopMode, type QueuedTrack, type Track, ValidationError } from "@rawon/shared";

export interface TrackQueueOptions {
    maxSize?: number;
    historyLimit?: number;
}

export interface AddTrackInput {
    track: Track;
    requesterId: string;
    requesterTag?: string;
    key?: string;
    index?: number;
    addedAt?: number;
}

export interface QueueStateSnapshot {
    currentKey: string | null;
    loopMode: LoopMode;
    shuffle: boolean;
    tracks: QueuedTrack[];
}

export class TrackQueue extends EventEmitter {
    private readonly items = new Map<string, QueuedTrack>();
    private readonly history: QueuedTrack[] = [];
    private sequence = 0;
    private currentKeyValue: string | null = null;
    private loopModeValue: LoopMode = "OFF";
    private shuffleValue = false;
    private maxSizeValue: number;
    private readonly historyLimit: number;

    public constructor(options: TrackQueueOptions = {}) {
        super();
        this.maxSizeValue = Math.max(1, options.maxSize ?? 500);
        this.historyLimit = Math.max(10, options.historyLimit ?? 100);
    }

    public get maxSize(): number {
        return this.maxSizeValue;
    }

    public set maxSize(limit: number) {
        this.maxSizeValue = Math.max(1, limit);
    }

    public get size(): number {
        return this.items.size;
    }

    public get currentKey(): string | null {
        return this.currentKeyValue;
    }

    public get current(): QueuedTrack | null {
        if (!this.currentKeyValue) {
            return null;
        }
        return this.items.get(this.currentKeyValue) ?? null;
    }

    public get loopMode(): LoopMode {
        return this.loopModeValue;
    }

    public get shuffle(): boolean {
        return this.shuffleValue;
    }

    public setLoopMode(mode: LoopMode): void {
        if (this.loopModeValue !== mode) {
            this.loopModeValue = mode;
            this.emit("stateChanged", { loopMode: mode });
        }
    }

    public cycleLoopMode(): LoopMode {
        const order: LoopMode[] = ["OFF", "QUEUE", "SONG"];
        const next = order[(order.indexOf(this.loopModeValue) + 1) % order.length] ?? "OFF";
        this.setLoopMode(next);
        return next;
    }

    public setShuffle(enabled: boolean): void {
        if (this.shuffleValue !== enabled) {
            this.shuffleValue = enabled;
            this.emit("stateChanged", { shuffle: enabled });
        }
    }

    public getAll(): QueuedTrack[] {
        return [...this.items.values()].sort((a, b) => a.index - b.index);
    }

    public getView(): QueuedTrack[] {
        const all = this.getAll();
        if (this.loopModeValue === "QUEUE") {
            return all;
        }
        const cur = this.current;
        if (!cur) {
            return all;
        }
        return all.filter((item) => item.index >= cur.index);
    }

    public getRemainingCount(): number {
        const view = this.getView();
        const curKey = this.currentKeyValue;
        return curKey ? view.filter((item) => item.key !== curKey).length : view.length;
    }

    public getTotalViewDuration(): number {
        return this.getView().reduce(
            (sum, item) =>
                sum +
                (Number.isFinite(item.track.duration) && item.track.duration > 0
                    ? item.track.duration
                    : 0),
            0,
        );
    }

    public getByKey(key: string): QueuedTrack | undefined {
        return this.items.get(key);
    }

    public add(input: AddTrackInput): QueuedTrack {
        const added = this.addMany([input]);
        const first = added[0];
        if (!first) {
            throw new ValidationError("Failed to add track to queue.");
        }
        return first;
    }

    public addMany(inputs: readonly AddTrackInput[]): QueuedTrack[] {
        if (inputs.length === 0) {
            return [];
        }

        const currentMaxIndex = this.getAll().reduce((max, item) => Math.max(max, item.index), 0);
        if (this.items.size + inputs.length > this.maxSizeValue) {
            const available = Math.max(0, this.maxSizeValue - this.items.size);
            if (available === 0) {
                throw new ValidationError(
                    `Queue limit of ${this.maxSizeValue} tracks has been reached.`,
                );
            }
        }

        const slice = inputs.slice(0, Math.max(0, this.maxSizeValue - this.items.size));
        const added: QueuedTrack[] = [];

        for (let i = 0; i < slice.length; i += 1) {
            const entry = slice[i];
            if (!entry) continue;
            this.sequence += 1;
            let key = entry.key ?? `trk_${Date.now().toString(36)}_${this.sequence}`;
            while (!entry.key && this.items.has(key)) {
                this.sequence += 1;
                key = `trk_${Date.now().toString(36)}_${this.sequence}`;
            }
            const index = entry.index ?? currentMaxIndex + i + 1;
            const queued: QueuedTrack = {
                key,
                index,
                track: entry.track,
                requesterId: entry.requesterId,
                requesterTag: entry.requesterTag,
                addedAt: entry.addedAt ?? Date.now(),
            };
            this.items.set(key, queued);
            if (!this.currentKeyValue && i === 0) {
                this.currentKeyValue = key;
            }
            added.push(queued);
        }

        if (added.length > 0) {
            this.emit("tracksAdded", added);
        }
        return added;
    }

    public restore(tracks: readonly QueuedTrack[], currentKey: string | null): void {
        this.items.clear();
        this.history.length = 0;
        let maxSeq = this.sequence;

        for (const item of tracks) {
            this.items.set(item.key, { ...item });
            if (item.index > maxSeq) {
                maxSeq = item.index;
            }
            const suffixMatch = /_(\d+)$/.exec(item.key);
            const suffixNum = suffixMatch ? Number.parseInt(suffixMatch[1] ?? "0", 10) : 0;
            if (Number.isFinite(suffixNum) && suffixNum > maxSeq) {
                maxSeq = suffixNum;
            }
        }
        this.sequence = maxSeq;

        if (currentKey && this.items.has(currentKey)) {
            this.currentKeyValue = currentKey;
        } else {
            this.currentKeyValue = this.getAll()[0]?.key ?? null;
        }
        this.emit("restored", this.snapshot());
    }

    public removeByKey(key: string): QueuedTrack | null {
        const existing = this.items.get(key);
        if (!existing) {
            return null;
        }
        const wasCurrent = this.currentKeyValue === key;
        if (wasCurrent) {
            const next = this.findNextTrack("skipped");
            this.currentKeyValue = next?.key ?? null;
        }
        this.items.delete(key);
        this.emit("tracksRemoved", [existing]);
        return existing;
    }

    public removeByPositions(positions1Based: readonly number[]): {
        removed: QueuedTrack[];
        removedCurrent: boolean;
    } {
        const view = this.getView();
        const uniqueTargets = new Map<string, QueuedTrack>();
        for (const pos of positions1Based) {
            if (!Number.isInteger(pos) || pos < 1) {
                continue;
            }
            const item = view[pos - 1];
            if (item) {
                uniqueTargets.set(item.key, item);
            }
        }

        const removed = [...uniqueTargets.values()];
        if (removed.length === 0) {
            return { removed: [], removedCurrent: false };
        }

        const currentKey = this.currentKeyValue;
        const removedCurrent = currentKey !== null && uniqueTargets.has(currentKey);

        for (const item of removed) {
            this.items.delete(item.key);
        }

        if (removedCurrent) {
            const cur = removed.find((r) => r.key === currentKey);
            const remaining = this.getAll();
            const next = cur
                ? (remaining.find((r) => r.index > cur.index) ??
                  (this.loopModeValue === "QUEUE" ? remaining[0] : undefined))
                : remaining[0];
            this.currentKeyValue = next?.key ?? null;
        }

        this.emit("tracksRemoved", removed);
        return { removed, removedCurrent };
    }

    public removeByRequester(requesterId: string): {
        removedCount: number;
        removedCurrent: boolean;
    } {
        const targets = this.getAll().filter((item) => item.requesterId === requesterId);
        if (targets.length === 0) {
            return { removedCount: 0, removedCurrent: false };
        }

        const currentKey = this.currentKeyValue;
        const removedCurrent = currentKey !== null && targets.some((t) => t.key === currentKey);
        const curItem = currentKey ? this.items.get(currentKey) : undefined;

        for (const t of targets) {
            this.items.delete(t.key);
        }

        if (removedCurrent) {
            const remaining = this.getAll();
            const next = curItem
                ? (remaining.find((r) => r.index > curItem.index) ??
                  (this.loopModeValue === "QUEUE" ? remaining[0] : undefined))
                : remaining[0];
            this.currentKeyValue = next?.key ?? null;
        }

        this.emit("tracksRemoved", targets);
        return { removedCount: targets.length, removedCurrent };
    }

    public advance(
        reason: "ended" | "skipped" = "ended",
        randomFn = Math.random,
    ): QueuedTrack | null {
        const cur = this.current;
        if (!cur) {
            const first = this.getAll()[0] ?? null;
            this.currentKeyValue = first?.key ?? null;
            return first;
        }

        if (reason === "ended" && this.loopModeValue === "SONG") {
            return cur;
        }

        this.pushHistory(cur);

        const next = this.findNextTrack(reason, randomFn);
        if (!next) {
            this.currentKeyValue = null;
            this.emit("stateChanged", { currentKey: null });
            return null;
        }

        if (this.shuffleValue && cur) {
            // Bring shuffled pick directly after current in logical order so queue view matches playback order
            this.placeRightAfter(next.key, cur.key);
        }

        this.currentKeyValue = next.key;
        this.emit("stateChanged", { currentKey: next.key });
        return next;
    }

    public movePrevious(): QueuedTrack | null {
        const cur = this.current;
        while (this.history.length > 0) {
            const prev = this.history.pop();
            if (!prev) continue;
            if (cur && prev.key === cur.key) continue;

            if (!this.items.has(prev.key)) {
                this.items.set(prev.key, prev);
            }
            this.currentKeyValue = prev.key;
            this.emit("stateChanged", { currentKey: prev.key });
            return prev;
        }

        // Fall back to previous item in ordered list if available
        if (cur) {
            const all = this.getAll();
            const idx = all.findIndex((item) => item.key === cur.key);
            if (idx > 0) {
                const prev = all[idx - 1];
                if (prev) {
                    this.currentKeyValue = prev.key;
                    this.emit("stateChanged", { currentKey: prev.key });
                    return prev;
                }
            }
        }
        return null;
    }

    public jumpToKey(key: string): QueuedTrack | null {
        const target = this.items.get(key);
        if (!target) {
            return null;
        }
        if (this.current && this.current.key !== key) {
            this.pushHistory(this.current);
        }
        this.currentKeyValue = key;
        this.emit("stateChanged", { currentKey: key });
        return target;
    }

    public jumpToTarget(target: "first" | "last" | number): QueuedTrack | null {
        const view = this.getView();
        if (view.length === 0) {
            return null;
        }
        let chosen: QueuedTrack | undefined;
        if (target === "first") {
            chosen = view[0];
        } else if (target === "last") {
            chosen = view[view.length - 1];
        } else if (Number.isInteger(target) && target >= 1) {
            chosen = view[target - 1];
        }
        if (!chosen) {
            return null;
        }
        return this.jumpToKey(chosen.key);
    }

    public getUpcomingTracks(limit?: number): QueuedTrack[] {
        const cur = this.current;
        const all = this.getAll();
        const upcoming = cur
            ? [
                  ...all.filter((item) => item.index > cur.index),
                  ...(this.loopModeValue === "QUEUE"
                      ? all.filter((item) => item.index < cur.index)
                      : []),
              ]
            : all;
        return limit === undefined ? upcoming : upcoming.slice(0, limit);
    }

    public hasHistory(): boolean {
        if (this.history.length > 0) {
            return true;
        }
        const cur = this.current;
        if (!cur) return false;
        const all = this.getAll();
        return all.findIndex((item) => item.key === cur.key) > 0;
    }

    public clear(): void {
        this.items.clear();
        this.history.length = 0;
        this.currentKeyValue = null;
        this.emit("cleared");
    }

    public snapshot(): QueueStateSnapshot {
        return {
            currentKey: this.currentKeyValue,
            loopMode: this.loopModeValue,
            shuffle: this.shuffleValue,
            tracks: this.getAll(),
        };
    }

    private findNextTrack(reason: "ended" | "skipped", randomFn = Math.random): QueuedTrack | null {
        const cur = this.current;
        const all = this.getAll();
        if (all.length === 0) {
            return null;
        }
        if (!cur) {
            return all[0] ?? null;
        }

        const after = all.filter((item) => item.index > cur.index);
        if (this.shuffleValue) {
            const pool =
                after.length > 0
                    ? after
                    : this.loopModeValue === "QUEUE"
                      ? all.filter((item) => item.key !== cur.key)
                      : [];
            if (pool.length === 0) {
                return this.loopModeValue === "QUEUE" ? (all[0] ?? null) : null;
            }
            const pick = Math.floor(randomFn() * pool.length);
            return pool[pick] ?? pool[0] ?? null;
        }

        if (after.length > 0) {
            return after[0] ?? null;
        }

        if (this.loopModeValue === "QUEUE") {
            return all[0] ?? null;
        }

        if (this.loopModeValue === "SONG" && reason === "ended") {
            return cur;
        }

        return null;
    }

    private placeRightAfter(movingKey: string, anchorKey: string): void {
        const ordered = this.getAll();
        const moving = this.items.get(movingKey);
        if (!moving) return;

        const filtered = ordered.filter((item) => item.key !== movingKey);
        const anchorIdx = filtered.findIndex((item) => item.key === anchorKey);
        if (anchorIdx === -1) return;

        filtered.splice(anchorIdx + 1, 0, moving);
        for (let i = 0; i < filtered.length; i += 1) {
            const item = filtered[i];
            if (item) {
                item.index = i + 1;
            }
        }
        this.sequence = Math.max(this.sequence, filtered.length + 1);
    }

    private pushHistory(track: QueuedTrack): void {
        const last = this.history[this.history.length - 1];
        if (last?.key === track.key) {
            return;
        }
        this.history.push(track);
        if (this.history.length > this.historyLimit) {
            this.history.shift();
        }
    }
}
