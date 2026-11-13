import {
    type BotHeartbeatInfo,
    InMemoryCoordinator,
    selectDeterministicPrimary,
} from "@rawon/database";
import { describe, expect, it } from "vitest";

function makeBot(botId: string, tokenIndex: number, guilds: string[]): BotHeartbeatInfo {
    return {
        botId,
        tokenIndex,
        tag: `Rawon#${1000 + tokenIndex}`,
        guildIds: guilds,
        activeVoiceSessions: 0,
        updatedAt: Date.now(),
    };
}

describe("Multi-Bot Coordination, Failover & Rate Limiting", () => {
    it("maintains sticky primary election and fails over deterministically when incumbent disconnects", async () => {
        const coordinator = new InMemoryCoordinator();
        await coordinator.connect();

        const b0 = makeBot("bot_0", 0, ["g1", "g2"]);
        const b1 = makeBot("bot_1", 1, ["g1"]);
        const b2 = makeBot("bot_2", 2, ["g1"]);

        await coordinator.registerBotHeartbeat(b0, 5_000);
        await coordinator.registerBotHeartbeat(b1, 5_000);
        await coordinator.registerBotHeartbeat(b2, 5_000);

        const active = await coordinator.listActiveBots();
        expect(active).toHaveLength(3);

        // Lowest tokenIndex becomes initial primary
        const firstPrimary = await coordinator.electPrimaryBot("g1", active);
        expect(firstPrimary).toBe("bot_0");

        // Stickiness preserves incumbent even if listed later
        expect(selectDeterministicPrimary([b2, b1, b0], "bot_1")).toBe("bot_1");

        // Failover when bot_0 goes offline
        const remainingPrimary = await coordinator.electPrimaryBot("g1", [b2, b1]);
        expect(remainingPrimary).toBe("bot_1");

        // Expired heartbeat disappears automatically
        await coordinator.registerBotHeartbeat(b2, 20);
        await new Promise((r) => setTimeout(r, 35));
        const afterExpiry = await coordinator.listActiveBots();
        expect(afterExpiry.some((b) => b.botId === "bot_2")).toBe(false);

        await coordinator.close();
    });

    it("enforces exclusive per-channel voice ownership locks with renewal and release", async () => {
        const coordinator = new InMemoryCoordinator();

        expect(await coordinator.acquireVoiceOwnership("g1", "vc_100", "bot_0", 5_000)).toBe(true);
        // Same bot re-acquiring / renewing succeeds
        expect(await coordinator.acquireVoiceOwnership("g1", "vc_100", "bot_0", 5_000)).toBe(true);
        // Competing bot is denied while lock is held
        expect(await coordinator.acquireVoiceOwnership("g1", "vc_100", "bot_1", 5_000)).toBe(false);
        expect(await coordinator.getVoiceOwner("g1", "vc_100")).toBe("bot_0");

        // Different voice channel in same guild CAN be owned independently by bot_1
        expect(await coordinator.acquireVoiceOwnership("g1", "vc_200", "bot_1", 5_000)).toBe(true);

        // Unauthorized release/renew by non-owner fails silently/false
        expect(await coordinator.renewVoiceOwnership("g1", "vc_100", "bot_1", 5_000)).toBe(false);
        await coordinator.releaseVoiceOwnership("g1", "vc_100", "bot_1");
        expect(await coordinator.getVoiceOwner("g1", "vc_100")).toBe("bot_0");

        // Authorized release frees channel immediately for failover
        await coordinator.releaseVoiceOwnership("g1", "vc_100", "bot_0");
        expect(await coordinator.acquireVoiceOwnership("g1", "vc_100", "bot_1", 5_000)).toBe(true);
    });

    it("enforces sliding-window request channel rate limits and pub/sub delivery", async () => {
        const coordinator = new InMemoryCoordinator();

        const r1 = await coordinator.checkRateLimit("rc:g1:u1", 2, 100);
        const r2 = await coordinator.checkRateLimit("rc:g1:u1", 2, 100);
        const r3 = await coordinator.checkRateLimit("rc:g1:u1", 2, 100);

        expect(r1.allowed).toBe(true);
        expect(r1.remaining).toBe(1);
        expect(r2.allowed).toBe(true);
        expect(r2.remaining).toBe(0);
        expect(r3.allowed).toBe(false);
        expect(r3.retryAfterMs).toBeGreaterThan(0);

        await new Promise((r) => setTimeout(r, 120));
        const r4 = await coordinator.checkRateLimit("rc:g1:u1", 2, 100);
        expect(r4.allowed).toBe(true);

        const received: string[] = [];
        const unsub = coordinator.onEvent((ev) => {
            if (ev.type === "precache_request") {
                received.push(String(ev.payload.key));
            }
        });
        await coordinator.publishEvent({
            type: "precache_request",
            payload: { key: "yt:abc" },
            timestamp: Date.now(),
        });
        unsub();
        expect(received).toEqual(["yt:abc"]);
    });
});
