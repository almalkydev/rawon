import { SUPPORTED_LOCALES } from "@rawon/config";
import { PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const languageCommand: CommandDefinition = {
    name: "language",
    aliases: ["lang", "locale"],
    category: "general",
    descriptionKey: "commands.general.language.description",
    usage: "commands.general.language.usage",
    cooldownMs: 3_000,
    guards: { guildOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("language")
            .setDescription(i18n.translate("commands.general.language.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.language.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("view")
                    .setDescription(
                        i18n.translate("commands.general.language.slashViewDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("set")
                    .setDescription(
                        i18n.translate("commands.general.language.slashSetDescription", "en-US"),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("locale")
                            .setDescription(
                                i18n.translate(
                                    "commands.general.language.slashLocaleOption",
                                    "en-US",
                                ),
                            )
                            .setRequired(true)
                            .addChoices(
                                ...SUPPORTED_LOCALES.map((loc) => ({ name: loc, value: loc })),
                            ),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("reset")
                    .setDescription(
                        i18n.translate("commands.general.language.slashResetDescription", "en-US"),
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const sub = (ctx.args.getSubcommand(0) ?? "view").toLowerCase();

        if (sub === "view") {
            const cfg = await ctx.services.store.getGuildConfig(ctx.guild.id);
            const cur = cfg.locale ?? ctx.services.config.defaultLocale;
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.general.language.embedTitle"),
                    description: `${ctx.t("commands.general.language.currentLanguage")} \`${cur}\`\n\n**${ctx.t("commands.general.language.availableLocales")}:**\n${SUPPORTED_LOCALES.map((l) => `\`${l}\``).join(", ")}`,
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
                    description: `${botSettings.noEmoji} ${ctx.t("commands.general.language.noPermission")}`,
                }),
                true,
            );
            return;
        }

        if (sub === "reset") {
            await ctx.services.store.setGuildLocale(ctx.guild.id, null);
            await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
            const fallback = ctx.services.config.defaultLocale;
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.general.language.embedTitle"),
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.general.language.languageReset")} \`${fallback}\``,
                }),
            );
            return;
        }

        const targetLocale = ctx.args.getString("locale", 1) ?? ctx.args.getString("locale", 0);
        if (
            !targetLocale ||
            !SUPPORTED_LOCALES.includes(targetLocale as (typeof SUPPORTED_LOCALES)[number])
        ) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.general.language.invalidLocale")} ${SUPPORTED_LOCALES.map((l) => `\`${l}\``).join(", ")}`,
                }),
                true,
            );
            return;
        }

        await ctx.services.store.setGuildLocale(ctx.guild.id, targetLocale);
        await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
        const updatedT = ctx.services.i18n.scoped(targetLocale);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                title: updatedT("commands.general.language.embedTitle"),
                description: `${botSettings.yesEmoji} ${updatedT("commands.general.language.languageSet")} \`${targetLocale}\``,
            }),
        );
    },
};
