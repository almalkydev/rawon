import { normalizeTime, parseTime } from "@rawon/shared";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const seekCommand: CommandDefinition = {
    name: "seek",
    aliases: ["sk", "jump"],
    category: "music",
    descriptionKey: "commands.music.seek.description",
    usage: "commands.music.seek.usage",
    cooldownMs: 2_000,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
        requireCurrentTrack: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("seek")
            .setDescription(i18n.translate("commands.music.seek.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.seek.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("time")
                    .setDescription(
                        i18n.translate("commands.music.seek.slashTimeDescription", "en-US"),
                    )
                    .setRequired(true),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const current = ctx.activeSession.currentTrack;
        if (!current) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.seek.noPlaying")}`,
                }),
                true,
            );
            return;
        }

        if (
            !canControlPlayback({
                member: ctx.member,
                guildConfig,
                currentRequesterId: current.requesterId,
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

        if (current.track.isLive) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.seek.cantSeekLive")}`,
                }),
                true,
            );
            return;
        }

        const timeRaw = ctx.args.getString("time", 0);
        if (!timeRaw) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.seek.noTime")}`,
                }),
                true,
            );
            return;
        }

        const targetSeconds = parseTime(timeRaw);
        if (targetSeconds === null) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.seek.invalidTime", { time: `\`${timeRaw}\`` })}`,
                }),
                true,
            );
            return;
        }

        if (current.track.duration > 0 && targetSeconds >= current.track.duration) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.seek.exceedsDuration", { duration: `\`${normalizeTime(current.track.duration)}\`` })}`,
                }),
                true,
            );
            return;
        }

        await ctx.defer();
        const seekedSec = await ctx.activeSession.seek(targetSeconds);
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);

        await ctx.editReply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.seek.seeked", { time: `\`${normalizeTime(seekedSec)}\`` })}`,
            }),
        );
    },
};
