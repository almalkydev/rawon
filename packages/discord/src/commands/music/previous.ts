import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const previousCommand: CommandDefinition = {
    name: "previous",
    aliases: ["prev", "back"],
    category: "music",
    descriptionKey: "commands.music.previous.description",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("previous")
            .setDescription(i18n.translate("commands.music.previous.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.previous.description", 100),
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

        if (!ctx.activeSession.queue.hasHistory()) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.previous.noPrevious")}`,
                }),
                true,
            );
            return;
        }

        await ctx.defer();
        const prev = await ctx.activeSession.previous();
        if (!prev) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.previous.noPrevious")}`,
                }),
                true,
            );
            return;
        }

        void ctx.services
            .syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId)
            .catch(() => undefined);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t(
                    "commands.music.previous.previousMessage",
                    {
                        song: `**[${prev.track.title}](${prev.track.url})**`,
                    },
                )}`,
            }),
        );
    },
};
