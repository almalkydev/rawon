import { FILTER_NAMES, type FilterName } from "@rawon/shared";
import { SlashCommandBuilder } from "discord.js";
import { buildFilterSelectPayload, buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback } from "../../utils/guards.js";

const VALID_FILTERS = new Set<string>(FILTER_NAMES);

export const filterCommand: CommandDefinition = {
    name: "filter",
    aliases: ["filters", "fx", "eq"],
    category: "music",
    descriptionKey: "commands.music.filter.description",
    usage: "commands.music.filter.usage",
    cooldownMs: 2_000,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("filter")
            .setDescription(i18n.translate("commands.music.filter.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.filter.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("status")
                    .setDescription(
                        i18n.translate("commands.music.filter.slashStatusDescription", "en-US"),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("name")
                            .setDescription(
                                i18n.translate(
                                    "commands.music.filter.slashStatusFilterDescription",
                                    "en-US",
                                ),
                            )
                            .setRequired(false)
                            .addChoices(...FILTER_NAMES.map((f) => ({ name: f, value: f }))),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("enable")
                    .setDescription(
                        i18n.translate("commands.music.filter.slashStateDescription", "en-US", {
                            state: "enable",
                        }),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("name")
                            .setDescription(
                                i18n.translate(
                                    "commands.music.filter.slashStateFilterDescription",
                                    "en-US",
                                    { state: "enable" },
                                ),
                            )
                            .setRequired(true)
                            .addChoices(...FILTER_NAMES.map((f) => ({ name: f, value: f }))),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("disable")
                    .setDescription(
                        i18n.translate("commands.music.filter.slashStateDescription", "en-US", {
                            state: "disable",
                        }),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("name")
                            .setDescription(
                                i18n.translate(
                                    "commands.music.filter.slashStateFilterDescription",
                                    "en-US",
                                    { state: "disable" },
                                ),
                            )
                            .setRequired(true)
                            .addChoices(...FILTER_NAMES.map((f) => ({ name: f, value: f }))),
                    ),
            )
            .addSubcommand((sub) =>
                sub.setName("reset").setDescription("Disable all active filters and equalizer"),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const sub = (ctx.args.getSubcommand(0) ?? "status").toLowerCase();

        if (sub === "status") {
            const nameArg = ctx.args.getString("name", 1)?.toLowerCase();
            if (nameArg && VALID_FILTERS.has(nameArg)) {
                const enabled = Boolean(
                    ctx.activeSession.getPlayerState().filters[nameArg as FilterName],
                );
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: ctx.t("commands.music.filter.currentState", {
                            filter: `\`${nameArg}\``,
                            state: `**${ctx.t(enabled ? "reusable.enabled" : "reusable.disabled")}**`,
                        }),
                    }),
                );
                return;
            }

            await ctx.reply(
                buildFilterSelectPayload({
                    activeFilters: ctx.activeSession.getPlayerState().filters,
                    botSettings,
                    t: ctx.t,
                    botId: ctx.activeSession.botId,
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

        if (sub === "reset") {
            await ctx.activeSession.resetFilters();
            await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("requestChannel.noFiltersActive")}`,
                }),
            );
            return;
        }

        const targetName = (
            ctx.args.getString("name", 1) ?? ctx.args.getString("name", 0)
        )?.toLowerCase();
        if (!targetName || !VALID_FILTERS.has(targetName)) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.filter.specifyFilter")}\n${FILTER_NAMES.map((f) => `\`${f}\``).join(", ")}`,
                }),
                true,
            );
            return;
        }

        const wantEnable = sub === "enable";
        const currentlyEnabled = Boolean(
            ctx.activeSession.getPlayerState().filters[targetName as FilterName],
        );

        let finalEnabled = currentlyEnabled;
        if (sub === "enable" || sub === "disable") {
            if (currentlyEnabled !== wantEnable) {
                const res = await ctx.activeSession.toggleFilter(targetName as FilterName);
                finalEnabled = res.enabled;
            }
        } else {
            const res = await ctx.activeSession.toggleFilter(targetName as FilterName);
            finalEnabled = res.enabled;
        }

        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);
        const stateText = ctx.t(finalEnabled ? "reusable.enabled" : "reusable.disabled");

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.filter.filterSet", {
                    filter: `\`${targetName}\``,
                    state: `**${stateText}**`,
                })}`,
            }),
        );
    },
};
