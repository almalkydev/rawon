import { AutoplayPlanner, TrackQueue } from "@rawon/queue";
import { type Track, ValidationError } from "@rawon/shared";
import { describe, expect, it } from "vitest";

function makeTrack(id: string, duration = 180): Track {
    return {
        id,
        title: `Track ${id}`,
        url: `https://www.youtube.com/watch?v=${id}`,
        duration,
        thumbnail: "https://i.ytimg.com/vi/default.jpg",
        author: `Artist ${id}`,
        provider: "youtube",
    };
}

describe("TrackQueue & AutoplayPlanner", () => {
    it("enqueues tracks, advances through OFF mode, and supports movePrevious history fallback", () => {
        const queue = new TrackQueue({ maxSize: 10 });
        queue.addMany([
            { track: makeTrack("t1"), requesterId: "u1" },
            { track: makeTrack("t2"), requesterId: "u2" },
            { track: makeTrack("t3"), requesterId: "u1" },
        ]);

        expect(queue.size).toBe(3);
        expect(queue.current?.track.id).toBe("t1");
        expect(queue.getRemainingCount()).toBe(2);
        expect(queue.getTotalViewDuration()).toBe(540);

        const second = queue.advance("ended");
        expect(second?.track.id).toBe("t2");
        expect(queue.hasHistory()).toBe(true);

        const back = queue.movePrevious();
        expect(back?.track.id).toBe("t1");

        const jumpLast = queue.jumpToTarget("last");
        expect(jumpLast?.track.id).toBe("t3");

        const endAdvance = queue.advance("ended");
        expect(endAdvance).toBeNull();
        expect(queue.current).toBeNull();
    });

    it("supports SONG loop on ended while advancing on manual skip", () => {
        const queue = new TrackQueue();
        queue.addMany([
            { track: makeTrack("s1"), requesterId: "u1" },
            { track: makeTrack("s2"), requesterId: "u1" },
        ]);
        queue.setLoopMode("SONG");

        expect(queue.advance("ended")?.track.id).toBe("s1");
        expect(queue.advance("skipped")?.track.id).toBe("s2");
    });

    it("wraps around in QUEUE loop and supports shuffle placement", () => {
        const queue = new TrackQueue();
        queue.addMany([
            { track: makeTrack("q1"), requesterId: "u1" },
            { track: makeTrack("q2"), requesterId: "u1" },
            { track: makeTrack("q3"), requesterId: "u1" },
        ]);
        queue.setLoopMode("QUEUE");

        queue.setShuffle(true);
        // Deterministic randomFn picking the last candidate
        const picked = queue.advance("skipped", () => 0.99);
        expect(picked?.track.id).toBe("q3");

        // Turning shuffle off still cycles cleanly around queue
        queue.setShuffle(false);
        const view = queue.getView();
        expect(view.length).toBe(3);

        // Advance until wrapping back
        const afterQ3 = queue.advance("ended");
        expect(afterQ3).not.toBeNull();
    });

    it("enforces bounded maxSize and removes by positions and requester", () => {
        const queue = new TrackQueue({ maxSize: 3 });
        queue.addMany([
            { track: makeTrack("a"), requesterId: "u1" },
            { track: makeTrack("b"), requesterId: "u2" },
            { track: makeTrack("c"), requesterId: "u1" },
        ]);

        expect(() => queue.add({ track: makeTrack("d"), requesterId: "u3" })).toThrow(
            ValidationError,
        );

        const posRemoved = queue.removeByPositions([2]);
        expect(posRemoved.removed.map((r) => r.track.id)).toEqual(["b"]);
        expect(posRemoved.removedCurrent).toBe(false);
        expect(queue.size).toBe(2);

        const reqRemoved = queue.removeByRequester("u1");
        expect(reqRemoved.removedCount).toBe(2);
        expect(reqRemoved.removedCurrent).toBe(true);
        expect(queue.size).toBe(0);
    });

    it("avoids recent repeats in AutoplayPlanner and caches second candidate as prefetched", async () => {
        const planner = new AutoplayPlanner({ repeatWindowSize: 5 });
        const seed = makeTrack("seed");
        const r1 = makeTrack("rel1");
        const r2 = makeTrack("rel2");
        const r3 = makeTrack("rel3");

        planner.recordPlayed(seed);
        planner.recordPlayed(r1);

        const picked = await planner.selectNext(
            seed,
            async (_s, excludeIds) => {
                expect(excludeIds.has("seed")).toBe(true);
                expect(excludeIds.has("rel1")).toBe(true);
                return [r1, r2, r3];
            },
            [],
        );

        expect(picked?.id).toBe("rel2");
        expect(planner.getPrefetched()?.id).toBe("rel3");

        // Next call reuses prefetched rel3 without hitting finder again
        let finderCalled = false;
        const picked2 = await planner.selectNext(seed, async () => {
            finderCalled = true;
            return [];
        });
        expect(finderCalled).toBe(false);
        expect(picked2?.id).toBe("rel3");
    });
});
