import { OAuth2Scopes, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

const INVITE_PERMISSIONS = [
    PermissionsBitField.Flags.ViewChannel,
    PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.EmbedLinks,
    PermissionsBitField.Flags.AttachFiles,
    PermissionsBitField.Flags.ReadMessageHistory,
    PermissionsBitField.Flags.ManageMessages,
    PermissionsBitField.Flags.Connect,
    PermissionsBitField.Flags.Speak,
    PermissionsBitField.Flags.UseVAD,
];

export const inviteCommand: CommandDefinition = {
    name: "invite",
    aliases: ["inv"],
    category: "general",
    descriptionKey: "commands.general.invite.description",
    cooldownMs: 3_000,
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("invite")
            .setDescription(i18n.translate("commands.general.invite.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.invite.description", 100),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const runtimes = ctx.services.getBotRuntimes();
        const isMulti = runtimes.length > 1;

        const lines = runtimes.map((rt, idx) => {
            const url = rt.client.generateInvite({
                scopes: [OAuth2Scopes.Bot, OAuth2Scopes.ApplicationsCommands],
                permissions: INVITE_PERMISSIONS,
            });
            return ctx.t("commands.general.invite.clickURL", {
                url,
                botNum: isMulti ? ` #${idx + 1} (${rt.tag})` : "",
            });
        });

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                title: ctx.t("commands.general.invite.inviteTitle", {
                    bot: ctx.client.user?.username ?? "Rawon",
                }),
                description: lines.join("\n"),
            }),
        );
    },
};
