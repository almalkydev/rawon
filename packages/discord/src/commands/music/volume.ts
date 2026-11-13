import { PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { memberHasDjPrivilege } from "../../utils/guards.js";

export const volumeCommand: CommandDefinition = {
    name: "volume",
    aliases: ["vol", "v"],
    category: "music",
    descriptionKey: "commands.music.volume.description",
    usage: "commands.music.volume.usage",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("volume")
            .setDescription(i18n.translate("commands.music.volume.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.volume.description", 100),
            )
            .addIntegerOption((opt) =>
                opt
                    .setName("volume")
                    .setDescription(
                        i18n.translate("commands.music.volume.slashDescription", "en-US"),
                    )
                    .setMinValue(1)
                    .setMaxValue(200)
                    .setRequired(false),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const newVol = ctx.args.getInteger("volume", 0);

        if (newVol === null) {
            const cur = ctx.activeSession.getPlayerState().volume;
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${ctx.t("commands.music.volume.currentVolume", { volume: `**\`${cur}%\`**` })}\n${ctx.t("commands.music.volume.changeVolume")}`,
                }),
            );
            return;
        }

        if (newVol <= 0) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.volume.plsPause", { volume: `\`${newVol}%\`` })}`,
                }),
                true,
            );
            return;
        }

        if (
            newVol > 100 &&
            !ctx.services.config.devs.includes(ctx.userId) &&
            !memberHasDjPrivilege(ctx.member, guildConfig) &&
            !ctx.member.permissions.has(PermissionsBitField.Flags.ManageGuild)
        ) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.volume.noPermission")}`,
                }),
                true,
            );
            return;
        }

        const updated = await ctx.activeSession.setVolume(Math.min(200, newVol));
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.volume.newVolume", { volume: `**\`${updated}%\`**` })}`,
            }),
        );
    },
};
