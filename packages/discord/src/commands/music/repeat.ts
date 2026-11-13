import type { LoopMode } from "@rawon/shared";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const repeatCommand: CommandDefinition = {
    name: "repeat",
    aliases: ["loop", "rp"],
    category: "music",
    descriptionKey: "commands.music.repeat.description",
    usage: "commands.music.repeat.usage",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("repeat")
            .setDescription(i18n.translate("commands.music.repeat.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.repeat.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("off")
                    .setDescription(i18n.translate("commands.music.repeat.slashDisable", "en-US")),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("queue")
                    .setDescription(i18n.translate("commands.music.repeat.slashQueue", "en-US")),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("song")
                    .setDescription(i18n.translate("commands.music.repeat.slashSong", "en-US")),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const sub = ctx.args.getSubcommand(0)?.toLowerCase() ?? null;

        if (!sub) {
            const cur = ctx.activeSession.getPlayerState().loopMode;
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${ctx.t("commands.music.repeat.actualMode", { mode: `**\`${cur}\`**` })}\n-# ${ctx.t("commands.music.repeat.footer", { prefix: ctx.prefix })}`,
                }),
            );
            return;
        }

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

        let target: LoopMode | null = null;
        if (sub === "off" || sub === "disable" || sub === "none") target = "OFF";
        else if (sub === "queue" || sub === "all") target = "QUEUE";
        else if (sub === "song" || sub === "track" || sub === "one") target = "SONG";

        if (!target) {
            const cycled = await ctx.activeSession.cycleLoopMode();
            await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.music.repeat.newMode", { mode: `**\`${cycled}\`**` })}`,
                }),
            );
            return;
        }

        await ctx.activeSession.setLoopMode(target);
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.repeat.newMode", { mode: `**\`${target}\`**` })}`,
            }),
        );
    },
};
