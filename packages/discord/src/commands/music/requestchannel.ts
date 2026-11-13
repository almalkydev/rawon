import { ChannelType, PermissionsBitField, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const requestChannelCommand: CommandDefinition = {
    name: "requestchannel",
    aliases: ["rc", "request", "setupmusic"],
    category: "music",
    descriptionKey: "commands.music.requestChannel.description",
    usage: "commands.music.requestChannel.usage",
    cooldownMs: 3_000,
    guards: { guildOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("requestchannel")
            .setDescription(i18n.translate("commands.music.requestChannel.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.requestChannel.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("set")
                    .setDescription(
                        i18n.translate(
                            "commands.music.requestChannel.slashSetDescription",
                            "en-US",
                        ),
                    )
                    .addChannelOption((opt) =>
                        opt
                            .setName("channel")
                            .setDescription(
                                i18n.translate(
                                    "commands.music.requestChannel.slashChannelDescription",
                                    "en-US",
                                ),
                            )
                            .addChannelTypes(
                                ChannelType.GuildText,
                                ChannelType.GuildVoice,
                                ChannelType.GuildStageVoice,
                            )
                            .setRequired(false),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("remove")
                    .setDescription(
                        i18n.translate(
                            "commands.music.requestChannel.slashRemoveDescription",
                            "en-US",
                        ),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("status")
                    .setDescription(
                        i18n.translate(
                            "commands.music.requestChannel.slashStatusDescription",
                            "en-US",
                        ),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("limits")
                    .setDescription("Configure request-channel queue limit and rate limiting")
                    .addIntegerOption((opt) =>
                        opt
                            .setName("max_queue")
                            .setDescription("Max tracks per server queue (10 - 2000)")
                            .setMinValue(10)
                            .setMaxValue(2000)
                            .setRequired(false),
                    )
                    .addIntegerOption((opt) =>
                        opt
                            .setName("rate_max")
                            .setDescription("Max requests per user in window (1 - 50)")
                            .setMinValue(1)
                            .setMaxValue(50)
                            .setRequired(false),
                    )
                    .addBooleanOption((opt) =>
                        opt
                            .setName("delete_requests")
                            .setDescription("Auto-delete request messages after queuing")
                            .setRequired(false),
                    ),
            ),
    execute: async (ctx) => {
        if (!ctx.guild) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const isDev = ctx.services.config.devs.includes(ctx.userId);
        const canManage =
            isDev || Boolean(ctx.member?.permissions.has(PermissionsBitField.Flags.ManageGuild));

        const sub = (ctx.args.getSubcommand(0) ?? "status").toLowerCase();

        if (sub === "status") {
            const rc = await ctx.services.store.getRequestChannel(ctx.guild.id, ctx.runtime.botId);
            const cfg = await ctx.services.store.getGuildConfig(ctx.guild.id);
            const desc = rc
                ? [
                      ctx.t("requestChannel.currentChannel", { channel: `<#${rc.channelId}>` }),
                      `**Max Queue:** \`${cfg.maxQueueSize}\` • **Rate Limit:** \`${cfg.rcRateLimitMax} / ${Math.round(cfg.rcRateLimitWindowMs / 1000)}s\` • **Cleanup:** \`${cfg.rcExclusions.deleteRequestMessages}\``,
                  ].join("\n")
                : ctx.t("requestChannel.noChannel");

            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: desc,
                }),
            );
            return;
        }

        if (!canManage) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.noPermission")}`,
                }),
                true,
            );
            return;
        }

        if (sub === "remove") {
            const existing = await ctx.services.store.getRequestChannel(
                ctx.guild.id,
                ctx.runtime.botId,
            );
            if (!existing) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.noChannelToRemove")}`,
                    }),
                    true,
                );
                return;
            }
            if (existing.messageId) {
                const ch = await ctx.guild.channels.fetch(existing.channelId).catch(() => null);
                if (ch && "messages" in ch) {
                    const msg = await ch.messages.fetch(existing.messageId).catch(() => null);
                    if (msg?.deletable) {
                        await msg.delete().catch(() => undefined);
                    }
                }
            }
            await ctx.services.store.deleteRequestChannel(ctx.guild.id, ctx.runtime.botId);
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("requestChannel.removeChannel")}`,
                }),
            );
            return;
        }

        if (sub === "limits") {
            const cfg = await ctx.services.store.getGuildConfig(ctx.guild.id);
            const maxQueueSize = ctx.args.getInteger("max_queue") ?? cfg.maxQueueSize;
            const rcRateLimitMax = ctx.args.getInteger("rate_max") ?? cfg.rcRateLimitMax;
            const deleteRequestMessages =
                ctx.args.getBoolean("delete_requests") ?? cfg.rcExclusions.deleteRequestMessages;

            await ctx.services.store.setGuildLimits(ctx.guild.id, {
                maxQueueSize,
                rcRateLimitMax,
                rcExclusions: {
                    ...cfg.rcExclusions,
                    deleteRequestMessages,
                },
            });
            await ctx.services.sessions.refreshGuildConfig(ctx.guild.id);

            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} Request channel settings updated: Max Queue \`${maxQueueSize}\`, Rate Limit \`${rcRateLimitMax}/${Math.round(cfg.rcRateLimitWindowMs / 1000)}s\`, Auto-Delete \`${deleteRequestMessages}\`.`,
                }),
            );
            return;
        }

        if (sub === "set") {
            const targetId =
                ctx.args.getChannelId("channel", 1) ??
                ctx.args.getChannelId("channel", 0) ??
                ctx.channel?.id ??
                null;
            if (!targetId) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.invalidChannel")}`,
                    }),
                    true,
                );
                return;
            }

            const existingForBot = await ctx.services.store.getRequestChannel(
                ctx.guild.id,
                ctx.runtime.botId,
            );
            if (existingForBot) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.alreadyHasChannel", { channel: `<#${existingForBot.channelId}>` })}`,
                    }),
                    true,
                );
                return;
            }

            const allForGuild = await ctx.services.store.getRequestChannelsForGuild(ctx.guild.id);
            if (allForGuild.some((r) => r.channelId === targetId)) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.channelAlreadyInUse")}`,
                    }),
                    true,
                );
                return;
            }

            const ch =
                ctx.guild.channels.cache.get(targetId) ??
                (await ctx.guild.channels.fetch(targetId).catch(() => null));
            if (
                !ch ||
                (ch.type !== ChannelType.GuildText &&
                    ch.type !== ChannelType.GuildVoice &&
                    ch.type !== ChannelType.GuildStageVoice)
            ) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.invalidChannel")}`,
                    }),
                    true,
                );
                return;
            }

            const me =
                ctx.guild.members.me ?? (await ctx.guild.members.fetchMe().catch(() => null));
            if (!me) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.noBotPermissions")}`,
                    }),
                    true,
                );
                return;
            }

            const perms = ch.permissionsFor(me);
            const needed = [
                PermissionsBitField.Flags.ViewChannel,
                PermissionsBitField.Flags.SendMessages,
                PermissionsBitField.Flags.ManageMessages,
            ];
            const missingNames = needed
                .filter((p) => !perms.has(p))
                .map((p) => new PermissionsBitField(p).toArray().join(""));
            if (missingNames.length > 0) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.music.requestChannel.missingBotPermissions", { permissions: missingNames.map((m) => `\`${m}\``).join(", ") })}`,
                    }),
                    true,
                );
                return;
            }

            await ctx.services.store.setRequestChannel({
                guildId: ctx.guild.id,
                botId: ctx.runtime.botId,
                channelId: ch.id,
                messageId: null,
            });
            await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.runtime.botId);

            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("requestChannel.setChannel", { channel: `<#${ch.id}>` })}`,
                }),
            );
            return;
        }

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: ctx.t("commands.music.requestChannel.usage", { prefix: ctx.prefix }),
            }),
            true,
        );
    },
};
