import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

function parsePositionsList(raw: string): number[] {
    const out = new Set<number>();
    for (const part of raw.split(/[\s,]+/u)) {
        const rangeMatch = /^(\d+)-(\d+)$/u.exec(part.trim());
        if (rangeMatch) {
            const a = Number(rangeMatch[1]);
            const b = Number(rangeMatch[2]);
            const lo = Math.min(a, b);
            const hi = Math.min(lo + 100, Math.max(a, b));
            for (let i = lo; i <= hi; i++) out.add(i);
            continue;
        }
        const n = Number(part.trim());
        if (Number.isInteger(n) && n >= 1) {
            out.add(n);
        }
    }
    return Array.from(out);
}

export const removeCommand: CommandDefinition = {
    name: "remove",
    aliases: ["rm", "del", "delete"],
    category: "music",
    descriptionKey: "commands.music.remove.description",
    usage: "commands.music.remove.usage",
    cooldownMs: 2_000,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("remove")
            .setDescription(i18n.translate("commands.music.remove.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.remove.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("positions")
                    .setDescription(
                        i18n.translate("commands.music.remove.slashPositionsDescription", "en-US"),
                    )
                    .setRequired(true),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const rawPos = ctx.args.getString("positions", 0, true);
        if (!rawPos) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.remove.noPositions")}`,
                }),
                true,
            );
            return;
        }

        const positions = parsePositionsList(rawPos);
        if (positions.length === 0) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.remove.noPositions")}`,
                }),
                true,
            );
            return;
        }

        const view = ctx.activeSession.queue.getAll();
        const isStaffOrDj = canControlPlayback({
            member: ctx.member,
            guildConfig,
            devs: ctx.services.config.devs,
        });
        if (!isStaffOrDj) {
            const unauthorized = positions.some((p) => {
                const target = view[p - 1];
                return target && target.requesterId !== ctx.userId;
            });
            if (unauthorized) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.remove.noPermission")}`,
                    }),
                    true,
                );
                return;
            }
        }

        const { removed, currentRemoved } = await ctx.activeSession.removeByPositions(positions);
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);

        const prefixMsg = currentRemoved ? ctx.t("commands.music.remove.songSkip") : "";
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${prefixMsg}${ctx.t("commands.music.remove.songsRemoved", { removed: removed.length })}`,
            }),
        );
    },
};
