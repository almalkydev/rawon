import { PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const prefixCommand: CommandDefinition = {
    name: "prefix",
    aliases: ["setprefix", "pfx"],
    category: "general",
    descriptionKey: "commands.general.prefix.description",
    usage: "commands.general.prefix.usage",
    cooldownMs: 3_000,
    guards: { guildOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("prefix")
            .setDescription(i18n.translate("commands.general.prefix.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.prefix.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("view")
                    .setDescription(
                        i18n.translate("commands.general.prefix.slashViewDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("set")
                    .setDescription(
                        i18n.translate("commands.general.prefix.slashSetDescription", "en-US"),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("prefix")
                            .setDescription(
                                i18n.translate(
                                    "commands.general.prefix.slashPrefixOption",
                                    "en-US",
                                ),
                            )
                            .setRequired(true)
                            .setMaxLength(10),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("reset")
                    .setDescription(
                        i18n.translate("commands.general.prefix.slashResetDescription", "en-US"),
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const subRaw = ctx.args.getSubcommand(0);
        const firstArg = ctx.args.getString("prefix", 0);

        const isView = subRaw === "view" || (!subRaw && !firstArg);
        if (isView) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.general.prefix.embedTitle"),
                    description: ctx.t("commands.general.prefix.currentPrefix", {
                        prefix: `\`${ctx.prefix}\``,
                    }),
                }),
            );
            return;
        }

        const isDev = ctx.services.config.devs.includes(ctx.userId);
        const hasPerm =
            isDev || Boolean(ctx.member?.permissions.has(PermissionsBitField.Flags.ManageGuild));
        if (!hasPerm) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.general.prefix.noPermission")}`,
                }),
                true,
            );
            return;
        }

        if (subRaw === "reset") {
            await ctx.services.store.setGuildPrefix(ctx.guild.id, null);
            await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.general.prefix.embedTitle"),
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.general.prefix.prefixReset", { prefix: `\`${ctx.services.config.mainPrefix}\`` })}`,
                }),
            );
            return;
        }

        const newPrefix =
            subRaw === "set"
                ? (ctx.args.getString("prefix", 1) ?? ctx.args.getString("prefix", 0))
                : firstArg;

        if (!newPrefix || newPrefix.length > 10) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.general.prefix.prefixTooLong")}`,
                }),
                true,
            );
            return;
        }

        await ctx.services.store.setGuildPrefix(ctx.guild.id, newPrefix);
        await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                title: ctx.t("commands.general.prefix.embedTitle"),
                description: `${botSettings.yesEmoji} ${ctx.t("commands.general.prefix.prefixSet", { prefix: `\`${newPrefix}\`` })}`,
            }),
        );
    },
};
