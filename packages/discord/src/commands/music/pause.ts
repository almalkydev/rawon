import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const pauseCommand: CommandDefinition = {
    name: "pause",
    aliases: ["ps"],
    category: "music",
    descriptionKey: "commands.music.pause.description",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
        requireCurrentTrack: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("pause")
            .setDescription(i18n.translate("commands.music.pause.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.pause.description", 100),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);

        if (
            !canControlPlayback({
                member: ctx.member,
                guildConfig,
                currentRequesterId: ctx.activeSession.currentTrack?.requesterId,
                devs: ctx.services.config.devs,
            })
        ) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("requestChannel.noPermission")}`,
                }),
                true,
            );
            return;
        }

        if (ctx.activeSession.paused) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.pause.alreadyPause")}`,
                }),
                true,
            );
            return;
        }

        await ctx.activeSession.pause();
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.pause.pauseMessage")}`,
            }),
        );
    },
};
