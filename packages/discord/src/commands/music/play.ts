import type { Track } from "@rawon/shared";
import { SlashCommandBuilder, type VoiceBasedChannel } from "discord.js";
import { DiscordVoiceTransport } from "../../DiscordVoiceTransport.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { checkBotVoicePermissions } from "../../utils/guards.js";

export const playCommand: CommandDefinition = {
    name: "play",
    aliases: ["p", "add"],
    category: "music",
    descriptionKey: "commands.music.play.description",
    usage: "commands.music.play.usage",
    cooldownMs: 2_000,
    guards: { guildOnly: true, inVoiceChannel: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("play")
            .setDescription(i18n.translate("commands.music.play.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.play.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("query")
                    .setDescription(
                        i18n.translate("commands.music.play.slashQueryDescription", "en-US"),
                    )
                    .setDescriptionLocalizations(
                        i18n.getDiscordLocalizations(
                            "commands.music.play.slashQueryDescription",
                            100,
                        ),
                    )
                    .setAutocomplete(true)
                    .setRequired(false),
            )
            .addAttachmentOption((opt) =>
                opt.setName("file").setDescription("Direct audio/video file").setRequired(false),
            ),
    autocomplete: async (interaction, services) => {
        const query = interaction.options.getFocused().trim();
        if (query.length < 3 || /^https?:\/\//iu.test(query)) {
            await interaction.respond([]).catch(() => undefined);
            return;
        }
        try {
            const settings = await services.store.getBotSettings();
            const res = await services.providers.search(
                query,
                "youtube",
                5,
                settings.searchProvider,
            );
            await interaction
                .respond(
                    res.items.slice(0, 5).map((item) => ({
                        name: `${item.title}${item.author ? ` — ${item.author}` : ""}`.slice(
                            0,
                            100,
                        ),
                        value: item.url.slice(0, 100),
                    })),
                )
                .catch(() => undefined);
        } catch {
            await interaction.respond([]).catch(() => undefined);
        }
    },
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
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
            const msgKey = permCheck.missing.includes("Connect")
                ? "utils.musicDecorator.validVCJoinable"
                : "utils.musicDecorator.validVCPermission";
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t(msgKey)}`,
                }),
                true,
            );
            return;
        }

        // Route to session already in this VC if multi-bot, else pick an idle bot in this guild
        const existingSessions = ctx.services.sessions.getSessionsForGuild(ctx.guild.id);
        const targetSession = existingSessions.find((s) => s.voiceChannelId === voiceChannel.id);
        const bestRuntime = targetSession
            ? (ctx.services.getBotRuntimes().find((r) => r.botId === targetSession.botId) ??
              ctx.runtime)
            : await ctx.runtime.pickBestBotForGuild(ctx.guild.id, voiceChannel.id);

        if (!targetSession && existingSessions.some((s) => s.botId === bestRuntime.botId)) {
            const active = existingSessions.find((s) => s.botId === bestRuntime.botId);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.play.alreadyPlaying", { voiceChannel: `<#${active?.voiceChannelId ?? ""}>` })}`,
                }),
                true,
            );
            return;
        }

        const query = ctx.args.getString("query", 0, true);
        const attachmentUrl =
            ctx.args.getAttachmentUrl("file") ?? ctx.message?.attachments.first()?.url ?? null;

        if (!query && !attachmentUrl) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.play.usage", { prefix: ctx.prefix })}`,
                }),
                true,
            );
            return;
        }

        await ctx.defer();

        try {
            let tracksToAdd: Track[] = [];
            let playlistTitle: string | undefined;

            if (attachmentUrl) {
                const fileName =
                    ctx.message?.attachments.first()?.name ??
                    ctx.interaction?.options.getAttachment("file")?.name ??
                    "Audio File";
                tracksToAdd.push({
                    id: `att_${Date.now()}`,
                    title: fileName,
                    url: attachmentUrl,
                    duration: 0,
                    thumbnail: "",
                    author: "Discord Attachment",
                    provider: "attachment" as const,
                });
            } else if (query) {
                const res = await ctx.services.providers.search(
                    query,
                    "youtube",
                    1,
                    botSettings.searchProvider,
                );
                tracksToAdd = res.playlist ? res.items : res.items.slice(0, 1);
                playlistTitle = res.playlist?.title;
            }

            if (tracksToAdd.length === 0) {
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.play.noSongData")}`,
                    }),
                );
                return;
            }

            const session =
                targetSession ??
                (await ctx.services.sessions.getOrCreateSession({
                    guildId: ctx.guild.id,
                    botId: bestRuntime.botId,
                    voiceChannelId: voiceChannel.id,
                    textChannelId: ctx.channel?.id ?? voiceChannel.id,
                    createTransport: () =>
                        new DiscordVoiceTransport({
                            client: bestRuntime.client,
                            logger: ctx.services.logger,
                        }),
                }));

            const capacity = Math.max(0, guildConfig.maxQueueSize - session.queue.size);
            if (capacity === 0) {
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("requestChannel.queueLimitReached", { limit: guildConfig.maxQueueSize })}`,
                    }),
                );
                return;
            }

            const boundedTracks = tracksToAdd.slice(0, capacity);
            const { startedImmediately } = await session.addAndMaybePlay({
                tracks: boundedTracks,
                requesterId: ctx.userId,
                requesterTag: ctx.userTag,
            });

            await ctx.services
                .syncRequestChannelPlayer(ctx.guild.id, session.botId)
                .catch(() => undefined);

            const first = boundedTracks[0];
            const desc = playlistTitle
                ? `${botSettings.yesEmoji} ${ctx.t("requestChannel.addedPlaylistToQueue", {
                      count: boundedTracks.length,
                      playlist: `**${playlistTitle}**`,
                  })}`
                : startedImmediately && first
                  ? `${botSettings.yesEmoji} ${ctx.t("utils.generalHandler.startPlaying", {
                        song: `**[${first.title}](${first.url})**`,
                    })}`
                  : `${botSettings.yesEmoji} ${ctx.t("requestChannel.addedToQueue", {
                        song: first ? `**[${first.title}](${first.url})**` : "",
                    })}`;

            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: desc,
                }),
            );
        } catch (err) {
            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t(
                        "utils.generalHandler.errorPlaying",
                        {
                            message: err instanceof Error ? err.message : String(err),
                        },
                    )}`,
                }),
            );
        }
    },
};
