import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer, buildPersistentPlayerPayload } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const nowPlayingCommand: CommandDefinition = {
    name: "nowplaying",
    aliases: ["np", "current"],
    category: "music",
    descriptionKey: "commands.music.nowplaying.description",
    cooldownMs: 3_000,
    guards: { guildOnly: true, requireActiveSession: true, requireCurrentTrack: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("nowplaying")
            .setDescription(i18n.translate("commands.music.nowplaying.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.nowplaying.description", 100),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const snapshot = ctx.activeSession.getSnapshot();
        if (!snapshot.currentTrack) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: ctx.t("commands.music.nowplaying.emptyQueue"),
                }),
                true,
            );
            return;
        }

        await ctx.reply(
            buildPersistentPlayerPayload({
                snapshot,
                botSettings,
                t: ctx.t,
                upcoming: ctx.activeSession.queue.getUpcomingTracks(3),
                guildName: ctx.guild.name,
            }),
        );
    },
};
