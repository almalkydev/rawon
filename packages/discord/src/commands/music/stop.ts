import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const stopCommand: CommandDefinition = {
    name: "stop",
    aliases: ["leave", "disconnect", "dc", "clear"],
    category: "music",
    descriptionKey: "commands.music.stop.description",
    cooldownMs: 2_000,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("stop")
            .setDescription(i18n.translate("commands.music.stop.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.stop.description", 100),
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

        const botId = ctx.activeSession.botId;
        await ctx.activeSession.stop({ leaveVoice: !botSettings.alwaysOn, clearQueue: true });
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, botId);

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.stop.stoppedMessage")}`,
            }),
        );
    },
};
