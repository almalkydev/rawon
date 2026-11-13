import { formatDurationMs, type GuildConfig, type LyricsResult, type Track } from "@rawon/shared";
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type Client,
    ContainerBuilder,
    type Guild,
    type GuildMember,
    MessageFlags,
    PermissionsBitField,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
    type VoiceBasedChannel,
} from "discord.js";
import { parseAccentColor } from "../playerUi.js";
import type { CommandContext } from "../types.js";

export function isDeveloperUser(userId: string, devs: readonly string[]): boolean {
    return devs.includes(userId);
}

export function memberHasDjPrivilege(member: GuildMember, guildConfig: GuildConfig): boolean {
    if (!guildConfig.djEnabled) return true;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    if (member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
    if (guildConfig.djRoleId && member.roles.cache.has(guildConfig.djRoleId)) return true;
    return false;
}

export function countHumanVoiceMembers(channel: VoiceBasedChannel): number {
    return channel.members.filter((m) => !m.user.bot).size;
}

export function canControlPlayback(params: {
    member: GuildMember;
    guildConfig: GuildConfig;
    currentRequesterId?: string | null;
    devs?: readonly string[];
}): boolean {
    if (params.devs && isDeveloperUser(params.member.id, params.devs)) return true;
    if (memberHasDjPrivilege(params.member, params.guildConfig)) return true;
    if (params.currentRequesterId && params.currentRequesterId === params.member.id) return true;
    const vc = params.member.voice.channel;
    if (vc && countHumanVoiceMembers(vc) <= 1) return true;
    return false;
}

export function checkBotVoicePermissions(
    client: Client,
    guild: Guild,
    voiceChannel: VoiceBasedChannel,
): { ok: boolean; missing: string[] } {
    const me =
        guild.members.me ?? (client.user ? guild.members.cache.get(client.user.id) : undefined);
    if (!me) {
        return { ok: true, missing: [] };
    }
    const perms = voiceChannel.permissionsFor(me);
    const missing: string[] = [];
    if (!perms.has(PermissionsBitField.Flags.ViewChannel)) missing.push("ViewChannel");
    if (!perms.has(PermissionsBitField.Flags.Connect)) missing.push("Connect");
    if (!perms.has(PermissionsBitField.Flags.Speak)) missing.push("Speak");
    return { ok: missing.length === 0, missing };
}

export function resolvePlaybackTargetBotId(ctx: CommandContext): string {
    if (ctx.activeSession) {
        return ctx.activeSession.botId;
    }
    if (ctx.guild) {
        const userVcId = ctx.member?.voice.channelId;
        const sessions = ctx.services.sessions.getSessionsForGuild(ctx.guild.id);
        if (userVcId) {
            const matching = sessions.find((s) => s.voiceChannelId === userVcId);
            if (matching) return matching.botId;
        }
        if (sessions[0]) return sessions[0].botId;
    }
    return ctx.runtime.botId;
}

const SELECTION_CACHE = new Map<
    string,
    {
        userId: string;
        guildId: string;
        channelId: string;
        tracks: Track[];
        expiresAt: number;
    }
>();

export function storePendingSelection(params: {
    id: string;
    userId: string;
    guildId: string;
    channelId: string;
    tracks: Track[];
    ttlMs?: number;
}): void {
    const now = Date.now();
    for (const [k, v] of SELECTION_CACHE) {
        if (v.expiresAt <= now) {
            SELECTION_CACHE.delete(k);
        }
    }
    SELECTION_CACHE.set(params.id, {
        userId: params.userId,
        guildId: params.guildId,
        channelId: params.channelId,
        tracks: params.tracks,
        expiresAt: now + (params.ttlMs ?? 60_000),
    });
}

export function consumePendingSelection(id: string): {
    userId: string;
    guildId: string;
    channelId: string;
    tracks: Track[];
} | null {
    const entry = SELECTION_CACHE.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        SELECTION_CACHE.delete(id);
        return null;
    }
    return entry;
}

export function deletePendingSelection(id: string): void {
    SELECTION_CACHE.delete(id);
}

export function findPendingSelectionForUser(
    guildId: string,
    channelId: string,
    userId: string,
): { id: string; tracks: Track[] } | null {
    const now = Date.now();
    for (const [id, entry] of SELECTION_CACHE) {
        if (entry.expiresAt <= now) {
            SELECTION_CACHE.delete(id);
            continue;
        }
        if (entry.guildId === guildId && entry.channelId === channelId && entry.userId === userId) {
            return { id, tracks: entry.tracks };
        }
    }
    return null;
}

const LYRICS_CACHE = new Map<string, { lyrics: LyricsResult; expiresAt: number }>();

export function storePendingLyrics(ownerId: string, lyrics: LyricsResult): void {
    const now = Date.now();
    for (const [k, v] of LYRICS_CACHE) {
        if (v.expiresAt <= now) LYRICS_CACHE.delete(k);
    }
    LYRICS_CACHE.set(ownerId, { lyrics, expiresAt: now + 300_000 });
}

export function getPendingLyrics(ownerId: string): LyricsResult | null {
    const entry = LYRICS_CACHE.get(ownerId);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        LYRICS_CACHE.delete(ownerId);
        return null;
    }
    return entry.lyrics;
}

export function buildTrackSelectionPayload(params: {
    selectionId: string;
    tracks: Track[];
    query: string;
    colorHex: string;
    mode: "selectmenu" | "message";
    promptText: string;
    cancelText: string;
}): { components: ContainerBuilder[]; flags: number } {
    const topTracks = params.tracks.slice(0, 10);
    const listText = topTracks
        .map((tr, idx) => {
            const dur = tr.isLive ? "LIVE" : formatDurationMs(tr.duration * 1000);
            return `\`${idx + 1}.\` **[${tr.title}](${tr.url})** — *${tr.author ?? "Unknown"}* (\`${dur}\`)`;
        })
        .join("\n");

    const container = new ContainerBuilder()
        .setAccentColor(parseAccentColor(params.colorHex))
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`### ${params.promptText}\n${listText}`),
        );

    if (params.mode === "selectmenu") {
        container.addActionRowComponents(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`search_select:${params.selectionId}`)
                    .setPlaceholder(params.promptText.slice(0, 100))
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(
                        topTracks.map((tr, idx) => ({
                            label: `${idx + 1}. ${tr.title}`.slice(0, 100),
                            description:
                                `${tr.author ?? tr.provider} (${tr.isLive ? "LIVE" : formatDurationMs(tr.duration * 1000)})`.slice(
                                    0,
                                    100,
                                ),
                            value: String(idx),
                        })),
                    ),
            ),
        );
    }

    container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`search_cancel:${params.selectionId}`)
                .setLabel(params.cancelText)
                .setStyle(ButtonStyle.Secondary),
        ),
    );

    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2,
    };
}
