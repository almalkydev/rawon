import { PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const djCommand: CommandDefinition = {
    name: "dj",
    aliases: ["djrole"],
    category: "music",
    descriptionKey: "commands.music.dj.description",
    usage: "commands.music.dj.usage",
    cooldownMs: 2_000,
    guards: { guildOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("dj")
            .setDescription(i18n.translate("commands.music.dj.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.dj.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("enable")
                    .setDescription(
                        i18n.translate("commands.music.dj.slashEnableDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("disable")
                    .setDescription(
                        i18n.translate("commands.music.dj.slashDisableDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("role")
                    .setDescription(
                        i18n.translate("commands.music.dj.slashRoleDescription", "en-US"),
                    )
                    .addRoleOption((opt) =>
                        opt
                            .setName("role")
                            .setDescription(
                                i18n.translate("commands.music.dj.slashRoleNewRoleOption", "en-US"),
                            )
                            .setRequired(false),
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const isDev = ctx.services.config.devs.includes(ctx.userId);
        const canManage =
            isDev || Boolean(ctx.member?.permissions.has(PermissionsBitField.Flags.ManageGuild));

        if (!canManage) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.dj.noPermission")}`,
                }),
                true,
            );
            return;
        }

        const cfg = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const sub = (ctx.args.getSubcommand(0) ?? "role").toLowerCase();

        if (sub === "enable") {
            await ctx.services.store.setGuildDj(ctx.guild.id, true, cfg.djRoleId);
            await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.music.dj.embedTitle"),
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.music.dj.enableText")}`,
                }),
            );
            return;
        }

        if (sub === "disable") {
            await ctx.services.store.setGuildDj(ctx.guild.id, false, cfg.djRoleId);
            await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.music.dj.embedTitle"),
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.music.dj.disableText")}`,
                }),
            );
            return;
        }

        const roleId = ctx.args.getRoleId("role", 1) ?? ctx.args.getRoleId("role", 0);
        if (!roleId) {
            const desc = cfg.djRoleId
                ? ctx.t("commands.music.dj.role.current", { role: cfg.djRoleId })
                : ctx.t("commands.music.dj.role.noRole", {
                      djRoleCmd: `\`${ctx.prefix}dj role @Role\``,
                  });
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.music.dj.embedTitle"),
                    description: desc,
                }),
            );
            return;
        }

        const role =
            ctx.guild.roles.cache.get(roleId) ??
            (await ctx.guild.roles.fetch(roleId).catch(() => null));
        if (!role) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.dj.role.invalid")}`,
                }),
                true,
            );
            return;
        }

        await ctx.services.store.setGuildDj(ctx.guild.id, true, role.id);
        await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                title: ctx.t("commands.music.dj.embedTitle"),
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.dj.role.success", { role: role.id })}`,
            }),
        );
    },
};
