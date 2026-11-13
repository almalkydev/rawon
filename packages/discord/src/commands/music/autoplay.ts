import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const autoplayCommand: CommandDefinition = {
    name: "autoplay",
    aliases: ["ap", "auto"],
    category: "music",
    descriptionKey: "commands.music.autoplay.description",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("autoplay")
            .setDescription(i18n.translate("commands.music.autoplay.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.autoplay.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("state")
                    .setDescription("enable | disable")
                    .setRequired(false)
                    .addChoices(
                        { name: "Enable", value: "enable" },
                        { name: "Disable", value: "disable" },
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const arg = ctx.args.getString("state", 0)?.toLowerCase();

        if (
            !canControlPlayback({
                member: ctx.member,
                guildConfig,
                currentRequesterId: ctx.activeSession.currentTrack?.requesterId,
                devs: ctx.services.config.devs,
            })
        ) {
            const state = ctx.activeSession.getPlayerState().autoplay
                ? ctx.t("reusable.enabled")
                : ctx.t("reusable.disabled");
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: ctx.t("commands.music.autoplay.actualState", {
                        state: `**${state}**`,
                    }),
                }),
            );
            return;
        }

        const next = arg
            ? arg === "enable" || arg === "on" || arg === "true"
            : !ctx.activeSession.getPlayerState().autoplay;
        await ctx.activeSession.setAutoplay(next);
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);

        const state = next ? ctx.t("reusable.enabled") : ctx.t("reusable.disabled");
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.autoplay.newState", { state: `**${state}**` })}`,
            }),
        );
    },
};
