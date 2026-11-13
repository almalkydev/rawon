import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
    exportDatabaseBundle,
    importDatabaseBundle,
    importFromLegacySqlite,
    MemoryDatabaseStore,
    parseAndValidateBundle,
} from "@rawon/database";
import { createLogger, type Track } from "@rawon/shared";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir) rmSync(dir, { recursive: true, force: true });
    }
});

describe("Database Store & V1/V2 Migration Bridge", () => {
    it("persists guild, request channel, player state, queue session, and exports/imports V2 bundles", async () => {
        const source = new MemoryDatabaseStore();
        await source.initialize();

        await source.setGuildPrefix("g1", "??");
        await source.setGuildLocale("g1", "ja-JP");
        await source.setGuildDj("g1", true, "role_dj_1");
        await source.setRequestChannel({
            guildId: "g1",
            botId: "bot_0",
            channelId: "ch_req_1",
            messageId: "msg_player_1",
        });
        await source.savePlayerState("g1", "bot_0", {
            loopMode: "QUEUE",
            shuffle: true,
            autoplay: true,
            volume: 85,
            qualityProfile: "fidelity",
            normalizeAudio: true,
            filters: { bassboost: true },
            equalizer: [{ frequency: 60, gainDb: 3, width: 1 }],
        });

        const sampleTrack: Track = {
            id: "dQw4w9WgXcQ",
            title: "Never Gonna Give You Up",
            url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            duration: 213,
            thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            author: "Rick Astley",
            provider: "youtube",
        };
        await source.saveQueueSession({
            guildId: "g1",
            botId: "bot_0",
            voiceChannelId: "vc_1",
            textChannelId: "txt_1",
            currentTrackKey: "trk_1",
            positionMs: 12_500,
            paused: false,
            tracks: [
                {
                    key: "trk_1",
                    index: 1,
                    track: sampleTrack,
                    requesterId: "u1",
                    requesterTag: "user#0001",
                    addedAt: Date.now(),
                },
            ],
        });
        await source.setBotSetting("embed_color", "FF5500");

        const bundle = await exportDatabaseBundle(source);
        expect(bundle.version).toBe("2.0.0");

        const parsed = parseAndValidateBundle(JSON.parse(JSON.stringify(bundle)));
        const target = new MemoryDatabaseStore();
        await target.initialize();
        const { counts } = await importDatabaseBundle(target, parsed, { clearExisting: true });

        expect(counts.guilds).toBe(1);
        expect(counts.request_channels).toBe(1);
        expect(counts.player_states).toBe(1);
        expect(counts.queue_states).toBe(1);
        expect(counts.bot_settings).toBeGreaterThanOrEqual(1);

        const migratedGuild = await target.getGuildConfig("g1");
        expect(migratedGuild.prefix).toBe("??");
        expect(migratedGuild.locale).toBe("ja-JP");
        expect(migratedGuild.djEnabled).toBe(true);
        expect(migratedGuild.djRoleId).toBe("role_dj_1");

        const migratedPs = await target.getPlayerState("g1", "bot_0");
        expect(migratedPs.loopMode).toBe("QUEUE");
        expect(migratedPs.shuffle).toBe(true);
        expect(migratedPs.normalizeAudio).toBe(true);
        expect(migratedPs.filters.bassboost).toBe(true);

        const restoredQueues = await target.listQueueSessionsForBot("bot_0");
        expect(restoredQueues).toHaveLength(1);
        expect(restoredQueues[0]?.positionMs).toBe(12_500);
        expect(restoredQueues[0]?.tracks[0]?.track.title).toBe("Never Gonna Give You Up");

        const settings = await target.getBotSettings();
        expect(settings.embedColor).toBe("FF5500");
    });

    it("imports legacy V1 SQLite data.db cleanly using node:sqlite", async () => {
        const dir = mkdtempSync(join(tmpdir(), "rawon-v1-sqlite-"));
        tempDirs.push(dir);
        const dbPath = join(dir, "legacy.db");

        const sqlite = new DatabaseSync(dbPath);
        sqlite.exec(`
            CREATE TABLE guilds (id TEXT PRIMARY KEY, prefix TEXT, locale TEXT, dj_enabled INTEGER, dj_role TEXT);
            CREATE TABLE request_channels (guild_id TEXT, bot_id TEXT, channel_id TEXT, message_id TEXT);
            CREATE TABLE player_states (guild_id TEXT, bot_id TEXT, loop_mode INTEGER, shuffle INTEGER, autoplay INTEGER, volume INTEGER, filters_json TEXT);
            CREATE TABLE queue_states (guild_id TEXT, bot_id TEXT, voice_channel_id TEXT, text_channel_id TEXT, current_song_key TEXT, position_ms INTEGER, paused INTEGER, songs_json TEXT);
            CREATE TABLE voice_channel_status_states (guild_id TEXT, bot_id TEXT, channel_id TEXT, status_set INTEGER);
            CREATE TABLE cookies_state (id INTEGER PRIMARY KEY, last_refresh INTEGER, cookie_hash TEXT, email TEXT, visitor_data TEXT, status TEXT);
            CREATE TABLE bot_settings (key TEXT PRIMARY KEY, value TEXT);
        `);

        sqlite
            .prepare(
                "INSERT INTO guilds (id, prefix, locale, dj_enabled, dj_role) VALUES (?, ?, ?, ?, ?)",
            )
            .run("g_legacy", "r!", "id-ID", 1, "dj_role_legacy");
        sqlite
            .prepare(
                "INSERT INTO request_channels (guild_id, bot_id, channel_id, message_id) VALUES (?, ?, ?, ?)",
            )
            .run("g_legacy", "default", "rc_ch_9", "rc_msg_9");
        sqlite
            .prepare(
                "INSERT INTO player_states (guild_id, bot_id, loop_mode, shuffle, autoplay, volume, filters_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .run("g_legacy", "default", 1, 1, 0, 90, JSON.stringify({ nightcore: true }));
        sqlite
            .prepare(
                "INSERT INTO queue_states (guild_id, bot_id, voice_channel_id, text_channel_id, current_song_key, position_ms, paused, songs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
                "g_legacy",
                "default",
                "vc_legacy",
                "txt_legacy",
                "legacy_k1",
                4500,
                0,
                JSON.stringify([
                    {
                        key: "legacy_k1",
                        index: 1,
                        requesterId: "u_legacy",
                        track: {
                            id: "yt_1234567890",
                            title: "Legacy Song",
                            url: "https://www.youtube.com/watch?v=yt_1234567890",
                            duration: 200,
                            author: "Legacy Artist",
                        },
                    },
                ]),
            );
        sqlite
            .prepare("INSERT INTO bot_settings (key, value) VALUES (?, ?)")
            .run("default_volume", "75");
        sqlite.close();

        const target = new MemoryDatabaseStore();
        await target.initialize();
        const logger = createLogger({ scope: "migration-test", level: "silent" });
        expect(logger).toBeDefined();

        const result = await importFromLegacySqlite(target, dbPath);
        expect(result.counts.guilds).toBe(1);
        expect(result.counts.player_states).toBe(1);
        expect(result.counts.queue_states).toBe(1);
        expect(result.warnings).toHaveLength(0);

        const ps = await target.getPlayerState("g_legacy", "default");
        expect(ps.loopMode).toBe("SONG"); // Numeric V1 loop_mode=1 normalized to SONG
        expect(ps.volume).toBe(90);
        expect(ps.filters.nightcore).toBe(true);

        const settings = await target.getBotSettings();
        expect(settings.defaultVolume).toBe(75);
    });
});
