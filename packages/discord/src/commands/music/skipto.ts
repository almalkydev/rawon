import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

export const skipToCommand: CommandDefinition = {
    name: "skipto",
    aliases: ["st", "skipt", "jumpto"],
    category: "music",
    descriptionKey: "commands.music.skipTo.description",
    usage: "commands.music.skipTo.usage",
    cooldownMs: 2_000,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("skipto")
            .setDescription(i18n.translate("commands.music.skipTo.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.skipTo.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("first")
                    .setDescription(
                        i18n.translate("commands.music.skipTo.slashFirstDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("last")
                    .setDescription(
                        i18n.translate("commands.music.skipTo.slashLastDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("specific")
                    .setDescription(
                        i18n.translate("commands.music.skipTo.slashSpecificDescription", "en-US"),
                    )
                    .addIntegerOption((opt) =>
                        opt
                            .setName("position")
                            .setDescription(
                                i18n.translate(
                                    "commands.music.skipTo.slashPositionDescription",
                                    "en-US",
                                ),
                            )
                            .setMinValue(1)
                            .setRequired(true),
                    ),
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
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.skipTo.noPermission")}`,
                }),
                true,
            );
            return;
        }

        const sub = ctx.args.getSubcommand(0)?.toLowerCase();
        const rawPos = ctx.args.getInteger("position", sub === "specific" ? 1 : 0);

        let target: "first" | "last" | number | null = null;
        if (sub === "first") target = "first";
        else if (sub === "last") target = "last";
        else if (rawPos !== null && rawPos >= 1) target = rawPos;

        if (target === null) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.skipTo.invalidPosition")}`,
                }),
                true,
            );
            return;
        }

        const view = ctx.activeSession.queue.getView();
        const targetIndex =
            target === "first" ? 0 : target === "last" ? view.length - 1 : target - 1;
        if (!view[targetIndex]) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.skipTo.noSongPosition")}`,
                }),
                true,
            );
            return;
        }

        await ctx.defer();
        const jumped = await ctx.activeSession.skipTo(target);
        if (!jumped) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.skipTo.noSongPosition")}`,
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
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.skipTo.skipMessage", {
                    song: `**[${jumped.track.title}](${jumped.track.url})**`,
                })}`,
            }),
        );
    },
};
