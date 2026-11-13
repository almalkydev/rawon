import { randomUUID } from "node:crypto";
import { SlashCommandBuilder, type VoiceBasedChannel } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import {
    buildTrackSelectionPayload,
    checkBotVoicePermissions,
    storePendingSelection,
} from "../../utils/guards.js";

export const searchCommand: CommandDefinition = {
    name: "search",
    aliases: ["find", "sc"],
    category: "music",
    descriptionKey: "commands.music.search.description",
    usage: "commands.music.search.usage",
    cooldownMs: 3_000,
    guards: { guildOnly: true, inVoiceChannel: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("search")
            .setDescription(i18n.translate("commands.music.search.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.search.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("query")
                    .setDescription(
                        i18n.translate("commands.music.search.slashQueryDescription", "en-US"),
                    )
                    .setRequired(true),
            )
            .addStringOption((opt) =>
                opt
                    .setName("source")
                    .setDescription(
                        i18n.translate("commands.music.search.slashSourceDescription", "en-US"),
                    )
                    .setRequired(false)
                    .addChoices(
                        { name: "YouTube", value: "youtube" },
                        { name: "SoundCloud", value: "soundcloud" },
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.channel) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const voiceChannel = ctx.member.voice.channel as VoiceBasedChannel | null;
        if (!voiceChannel) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.noInVC")}`,
                }),
                true,
            );
            return;
        }

        const permCheck = checkBotVoicePermissions(ctx.client, ctx.guild, voiceChannel);
        if (!permCheck.ok) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.validVCJoinable")}`,
                }),
                true,
            );
            return;
        }

        const rawQuery = ctx.args.getString("query", 0, true);
        if (!rawQuery) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.search.noQuery")}`,
                }),
                true,
            );
            return;
        }

        let sourceArg = ctx.args.getString("source");
        let query = rawQuery;
        if (!ctx.interaction && ctx.args.rawArgs.length > 1) {
            const last = ctx.args.rawArgs[ctx.args.rawArgs.length - 1]?.toLowerCase();
            if (last === "youtube" || last === "soundcloud" || last === "sc" || last === "yt") {
                sourceArg = last === "sc" || last === "soundcloud" ? "soundcloud" : "youtube";
                query = ctx.args.rawArgs.slice(0, -1).join(" ");
            }
        }
        const source = sourceArg === "soundcloud" ? "soundcloud" : "youtube";

        await ctx.defer();
        const result = await ctx.services.providers.search(
            query,
            source,
            10,
            botSettings.searchProvider,
        );
        if (result.items.length === 0) {
            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.search.noTracks")}`,
                }),
            );
            return;
        }

        const selectionId = randomUUID().slice(0, 12);
        storePendingSelection({
            id: selectionId,
            userId: ctx.userId,
            guildId: ctx.guild.id,
            channelId: ctx.channel.id,
            tracks: result.items.slice(0, 10),
        });

        await ctx.editReply(
            buildTrackSelectionPayload({
                selectionId,
                tracks: result.items,
                query,
                colorHex: botSettings.embedColor,
                mode: botSettings.musicSelectionType,
                promptText: ctx.t("commands.music.search.trackSelectionMessage"),
                cancelText: "Cancel",
            }),
        );
    },
};
