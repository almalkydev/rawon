import type { Track } from "@rawon/shared";

export type RelatedTrackFinder = (
    seedTrack: Track,
    excludeIds: ReadonlySet<string>,
) => Promise<Track[]>;

export interface AutoplayPlannerOptions {
    historyLimit?: number;
    repeatWindowSize?: number;
}

export class AutoplayPlanner {
    private readonly recentHistory: string[] = [];
    private prefetchedTrack: Track | null = null;
    private readonly historyLimit: number;
    private readonly repeatWindowSize: number;

    public constructor(options: AutoplayPlannerOptions = {}) {
        this.historyLimit = Math.max(10, options.historyLimit ?? 30);
        this.repeatWindowSize = Math.max(5, Math.min(14, options.repeatWindowSize ?? 10));
    }

    public recordPlayed(track: Track): void {
        const canonical = track.id || track.url;
        if (!canonical) return;

        const existingIdx = this.recentHistory.indexOf(canonical);
        if (existingIdx !== -1) {
            this.recentHistory.splice(existingIdx, 1);
        }
        this.recentHistory.push(canonical);
        if (this.recentHistory.length > this.historyLimit) {
            this.recentHistory.shift();
        }

        if (
            this.prefetchedTrack &&
            (this.prefetchedTrack.id === canonical || this.prefetchedTrack.url === canonical)
        ) {
            this.prefetchedTrack = null;
        }
    }

    public getExcludedIds(extraExcluded: readonly string[] = []): Set<string> {
        const recentWindow = this.recentHistory.slice(-this.repeatWindowSize);
        return new Set([...recentWindow, ...extraExcluded]);
    }

    public getPrefetched(): Track | null {
        return this.prefetchedTrack;
    }

    public setPrefetched(track: Track | null): void {
        this.prefetchedTrack = track;
    }

    public async selectNext(
        seedTrack: Track,
        finder: RelatedTrackFinder,
        queueTrackIds: readonly string[] = [],
    ): Promise<Track | null> {
        const excluded = this.getExcludedIds(queueTrackIds);
        if (this.prefetchedTrack) {
            const prefId = this.prefetchedTrack.id || this.prefetchedTrack.url;
            if (!excluded.has(prefId)) {
                const selected = this.prefetchedTrack;
                this.prefetchedTrack = null;
                return selected;
            }
            this.prefetchedTrack = null;
        }

        const candidates = await finder(seedTrack, excluded);
        const filtered = candidates.filter((candidate) => {
            const cid = candidate.id || candidate.url;
            return cid.length > 0 && !excluded.has(cid);
        });

        if (filtered.length > 0) {
            const next = filtered[0] ?? null;
            this.prefetchedTrack = filtered[1] ?? null;
            return next;
        }

        // Fallback ignoring window if every candidate was recently played
        const fallback = candidates.find(
            (c) => (c.id || c.url) !== (seedTrack.id || seedTrack.url),
        );
        return fallback ?? null;
    }

    public clear(): void {
        this.recentHistory.length = 0;
        this.prefetchedTrack = null;
    }
}
