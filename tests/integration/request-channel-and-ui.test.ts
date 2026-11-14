import {
    BOT_SETTINGS_DEFAULTS,
    createDefaultGuildConfig,
    createDefaultPlayerState,
    I18nService,
} from "@rawon/config";
import {
    buildFilterSelectPayload,
    buildPersistentPlayerPayload,
    buildQueuePagePayload,
    CommandRegistry,
    extractRequestPayloadFromMessage,
    parseNetscapeCookieEntries,
} from "@rawon/discord";
import type { SessionStateSnapshot } from "@rawon/music-core";
import type { QueuedTrack } from "@rawon/shared";
import { describe, expect, it } from "vitest";

const DISCORD_IS_COMPONENTS_V2 = 1 << 15; // MessageFlags.IsComponentsV2 (32768)

describe("Request Channel Parser, Discord Components V2 UI & Command Parity", () => {
    const baseConfig = createDefaultGuildConfig("g1");

    it("extracts songs, URLs, playlists, multi-line batch, and audio attachments while filtering noise", () => {
        const parsed = extractRequestPayloadFromMessage({
            content: "Blinding Lights\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ",
            isBot: false,
            authorId: "u1",
            roleIds: [],
            attachments: [
                {
                    id: "att1",
                    name: "demo.flac",
                    url: "https://cdn.discordapp.com/attachments/1/2/demo.flac",
                    contentType: "audio/flac",
                    size: 102400,
                },
                {
                    id: "att2",
                    name: "cover.png",
                    url: "https://cdn.discordapp.com/attachments/1/2/cover.png",
                    contentType: "image/png",
                    size: 4096,
                },
            ],
            botPrefixes: ["r!", "!"],
            guildConfig: baseConfig,
        });

        expect(parsed.ignoredReason).toBeUndefined();
        expect(parsed.queries).toEqual([
            "Blinding Lights",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        ]);
        expect(parsed.attachmentTracks).toHaveLength(1);
        expect(parsed.attachmentTracks[0]?.title).toBe("demo.flac");
        expect(parsed.attachmentTracks[0]?.provider).toBe("attachment");

        expect(
            extractRequestPayloadFromMessage({
                content: "r!skip",
                isBot: false,
                authorId: "u1",
                roleIds: [],
                attachments: [],
                botPrefixes: ["r!"],
                guildConfig: baseConfig,
            }).ignoredReason,
        ).toBe("excluded_prefix");

        expect(
            extractRequestPayloadFromMessage({
                content: "a".repeat(250),
                isBot: false,
                authorId: "u1",
                roleIds: [],
                attachments: [],
                botPrefixes: ["r!"],
                guildConfig: baseConfig,
            }).ignoredReason,
        ).toBe("too_long");

        expect(
            extractRequestPayloadFromMessage({
                content: "hello",
                isBot: true,
                authorId: "bot1",
                roleIds: [],
                attachments: [],
                botPrefixes: [],
                guildConfig: baseConfig,
            }).ignoredReason,
        ).toBe("bot");
    });

    it("builds strict Discord Components V2 payloads without mixing legacy embeds", () => {
        const i18n = new I18nService("en-US");
        const t = i18n.scoped("en-US");

        const standbyPayload = buildPersistentPlayerPayload({
            snapshot: null,
            botSettings: BOT_SETTINGS_DEFAULTS,
            t,
        });
        expect((standbyPayload.flags & DISCORD_IS_COMPONENTS_V2) !== 0).toBe(true);
        expect("embeds" in standbyPayload).toBe(false);

        const currentTrack: QueuedTrack = {
            key: "trk_1",
            index: 1,
            requesterId: "u1",
            addedAt: Date.now(),
            track: {
                id: "vid1",
                title: "Symphony No. 9",
                url: "https://www.youtube.com/watch?v=vid1",
                duration: 240,
                thumbnail: "https://i.ytimg.com/vi/vid1/hqdefault.jpg",
                author: "Orchestra",
                provider: "youtube",
            },
        };

        const snapshot: SessionStateSnapshot = {
            guildId: "g1",
            botId: "bot_0",
            voiceChannelId: "vc_1",
            textChannelId: "txt_1",
            status: "playing",
            paused: false,
            positionMs: 45_000,
            currentTrack,
            queueLength: 2,
            upcomingCount: 1,
            playerState: createDefaultPlayerState(),
            pipelineMode: "passthrough-webm-opus",
            startedAt: performance.now(),
        };

        const activePayload = buildPersistentPlayerPayload({
            snapshot,
            botSettings: BOT_SETTINGS_DEFAULTS,
            t,
            upcoming: [
                {
                    key: "trk_2",
                    index: 2,
                    requesterId: "u2",
                    addedAt: Date.now(),
                    track: {
                        id: "vid2",
                        title: "Second Track",
                        url: "https://www.youtube.com/watch?v=vid2",
                        duration: 190,
                        thumbnail: "",
                        author: "Artist",
                        provider: "youtube",
                    },
                },
            ],
        });

        expect((activePayload.flags & DISCORD_IS_COMPONENTS_V2) !== 0).toBe(true);
        expect("embeds" in activePayload).toBe(false);
        const serialized = JSON.stringify(activePayload.components.map((c) => c.toJSON()));
        for (const controlId of [
            "rc_prev",
            "rc_pause",
            "rc_skip",
            "rc_stop",
            "rc_shuffle",
            "rc_repeat",
            "rc_autoplay",
            "rc_volume",
            "rc_queue",
        ]) {
            expect(serialized).toContain(controlId);
        }

        const queuePayload = buildQueuePagePayload({
            tracks: [currentTrack],
            currentKey: "trk_1",
            page: 0,
            botSettings: BOT_SETTINGS_DEFAULTS,
            t,
            guildId: "g1",
            botId: "bot_0",
        });
        expect((queuePayload.flags & DISCORD_IS_COMPONENTS_V2) !== 0).toBe(true);

        const filterPayload = buildFilterSelectPayload({
            activeFilters: { bassboost: true },
            botSettings: BOT_SETTINGS_DEFAULTS,
            t,
            botId: "bot_0",
        });
        expect((filterPayload.flags & DISCORD_IS_COMPONENTS_V2) !== 0).toBe(true);
    });

    it("registers all 31 commands + Message Context Menu with localized definitions", () => {
        const registry = new CommandRegistry();
        expect(registry.listAll()).toHaveLength(31);
        expect(registry.resolveCommand("p")?.name).toBe("play");
        expect(registry.resolveCommand("np")?.name).toBe("nowplaying");
        expect(registry.resolveCommand("rc")?.name).toBe("requestchannel");

        const i18n = new I18nService("en-US");
        const appCommands = registry.buildApplicationCommandsJson(i18n);
        expect(appCommands.length).toBe(32); // 31 slash commands + 1 message context menu

        const loginCmd = appCommands.find((cmd) => cmd.name === "login");
        const loginOptions = loginCmd?.options as Array<{ name: string }> | undefined;
        expect(loginOptions?.some((opt) => opt.name === "cookies")).toBe(true);
    });

    it("parses Netscape cookies from multiline text, escaped env strings, and base64 blobs", () => {
        const netscapeText = [
            "# Netscape HTTP Cookie File",
            ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tSAPISID\tsecret_sapisid",
            ".google.com\tTRUE\t/\tFALSE\t0\tNID\tsession_nid",
            "malformed_line_only_three\tparts\there",
        ].join("\n");

        const direct = parseNetscapeCookieEntries(netscapeText);
        expect(direct).toHaveLength(2);
        expect(direct[0]).toMatchObject({
            domain: ".youtube.com",
            includeSubdomains: true,
            path: "/",
            secure: true,
            expiration: 1893456000,
            name: "SAPISID",
            value: "secret_sapisid",
        });

        const escaped = parseNetscapeCookieEntries(netscapeText.replace(/\n/g, "\\n"));
        expect(escaped).toHaveLength(2);
        expect(escaped[1]?.name).toBe("NID");

        const encoded = Buffer.from(netscapeText, "utf8").toString("base64");
        const decoded = parseNetscapeCookieEntries(encoded);
        expect(decoded).toHaveLength(2);
        expect(decoded[0]?.value).toBe("secret_sapisid");
    });
});
