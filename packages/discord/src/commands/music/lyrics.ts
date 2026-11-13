import { SlashCommandBuilder } from "discord.js";
import { buildLyricsPagePayload, buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { storePendingLyrics } from "../../utils/guards.js";

export const lyricsCommand: CommandDefinition = {
    name: "lyrics",
    aliases: ["ly", "lyric"],
    category: "music",
    descriptionKey: "commands.music.lyrics.description",
    usage: "commands.music.lyrics.usage",
    cooldownMs: 3_000,
    guards: { guildOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("lyrics")
            .setDescription(i18n.translate("commands.music.lyrics.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.lyrics.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("query")
                    .setDescription(
                        i18n.translate("commands.music.lyrics.slashDescription", "en-US"),
                    )
                    .setRequired(false),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const activeSession = ctx.activeSession;
        const currentTrack = activeSession?.currentTrack?.track ?? null;
        const explicitQuery = ctx.args.getString("query", 0, true);

        const songQuery = explicitQuery ?? currentTrack?.title ?? "";
        const artistHint = explicitQuery ? undefined : currentTrack?.author;

        if (!songQuery) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.lyrics.noQuery")}`,
                }),
                true,
            );
            return;
        }

        await ctx.defer();

        const combinedQuery = artistHint ? `${artistHint} ${songQuery}` : songQuery;
        const lyrics = await ctx.services.providers.lyrics.getLyrics(combinedQuery);

        if (!lyrics) {
            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.lyrics.noLyrics", { song: `**${songQuery}**` })}`,
                }),
            );
            return;
        }

        storePendingLyrics(ctx.userId, lyrics);
        await ctx.editReply(
            buildLyricsPagePayload({
                lyrics,
                page: 1,
                botSettings,
                t: ctx.t,
                ownerId: ctx.userId,
            }),
        );
    },
};
