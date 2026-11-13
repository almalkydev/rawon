import { formatCodeSpan } from "@rawon/shared";
import {
    ActionRowBuilder,
    ContainerBuilder,
    MessageFlags,
    SlashCommandBuilder,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
} from "discord.js";
import { parseAccentColor } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { isDeveloperUser } from "../../utils/guards.js";
import { getRegisteredCommands } from "../helpers.js";

export const helpCommand: CommandDefinition = {
    name: "help",
    aliases: ["h", "commands", "cmd"],
    category: "general",
    descriptionKey: "commands.general.help.description",
    usage: "commands.general.help.usage",
    cooldownMs: 3_000,
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("help")
            .setDescription(i18n.translate("commands.general.help.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.help.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("command")
                    .setDescription(
                        i18n.translate("commands.general.help.slashDescription", "en-US"),
                    )
                    .setDescriptionLocalizations(
                        i18n.getDiscordLocalizations("commands.general.help.slashDescription", 100),
                    )
                    .setAutocomplete(true)
                    .setRequired(false),
            ),
    autocomplete: async (interaction, _services) => {
        const focused = interaction.options.getFocused().toLowerCase();
        const matches = getRegisteredCommands()
            .filter((c) => c.name.includes(focused))
            .slice(0, 25)
            .map((c) => ({ name: c.name, value: c.name }));
        await interaction.respond(matches).catch(() => undefined);
    },
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const isDev = isDeveloperUser(ctx.userId, ctx.services.config.devs);
        const query = ctx.args.getString("command", 0)?.toLowerCase() ?? null;
        const commands = getRegisteredCommands().filter(
            (c) => c.category !== "developers" || isDev,
        );

        const container = new ContainerBuilder().setAccentColor(
            parseAccentColor(botSettings.embedColor),
        );

        if (query) {
            const match =
                commands.find((c) => c.name === query || c.aliases?.includes(query)) ?? null;
            if (!match) {
                const suggestion = commands.find((c) => c.name.startsWith(query));
                container.addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        suggestion
                            ? `${ctx.t("commands.general.help.noCommandSuggest")} \`${ctx.prefix}${suggestion.name}\``
                            : ctx.t("commands.general.help.noCommand"),
                    ),
                );
                await ctx.reply({
                    components: [container],
                    flags: MessageFlags.IsComponentsV2,
                });
                return;
            }

            const aliasesText =
                match.aliases && match.aliases.length > 0
                    ? match.aliases.map(formatCodeSpan).join(", ")
                    : ctx.t("commands.general.help.noAliases");
            const usageText = match.usage
                ? ctx.t(match.usage, { prefix: ctx.prefix, options: "queue | song | off" })
                : `${ctx.prefix}${match.name}`;

            const detail = [
                `### ${ctx.t("commands.general.help.commandDetailTitle", { username: ctx.client.user?.username ?? "Rawon", command: match.name })}`,
                `**${ctx.t("commands.general.help.nameString")}:** \`${match.name}\``,
                `**${ctx.t("commands.general.help.descriptionString")}:** ${ctx.t(match.descriptionKey)}`,
                `**${ctx.t("commands.general.help.aliasesString")}:** ${aliasesText}`,
                `**${ctx.t("commands.general.help.usageString")}:** \`${usageText}\``,
                `-# ${ctx.t("commands.general.help.commandUsageFooter", { devOnly: match.category === "developers" ? "| Dev Only" : "" })}`,
            ].join("\n");

            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(detail));
            await ctx.reply({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
            });
            return;
        }

        const generalCmds = commands
            .filter((c) => c.category === "general")
            .map((c) => `\`${c.name}\``)
            .join(", ");
        const musicCmds = commands
            .filter((c) => c.category === "music")
            .map((c) => `\`${c.name}\``)
            .join(", ");
        const devCmds = commands
            .filter((c) => c.category === "developers")
            .map((c) => `\`${c.name}\``)
            .join(", ");

        const sections = [
            `## ${ctx.t("commands.general.help.authorString", { username: ctx.client.user?.username ?? "Rawon" })}`,
            `**General (${commands.filter((c) => c.category === "general").length}):** ${generalCmds}`,
            `**Music (${commands.filter((c) => c.category === "music").length}):** ${musicCmds}`,
            devCmds ? `**Developers:** ${devCmds}` : null,
            `-# ${ctx.t("commands.general.help.footerString", { prefix: ctx.prefix })}`,
        ]
            .filter(Boolean)
            .join("\n\n");

        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(sections));
        container.addActionRowComponents(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`help_cmd:${ctx.runtime.botId}`)
                    .setPlaceholder(ctx.t("commands.general.help.commandSelectionString"))
                    .addOptions(
                        commands.slice(0, 25).map((c) => ({
                            label: `${ctx.prefix}${c.name}`,
                            description: ctx.t(c.descriptionKey).slice(0, 100),
                            value: c.name,
                        })),
                    ),
            ),
        );

        await ctx.reply({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });
    },
};
