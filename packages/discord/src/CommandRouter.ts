import { normalizeTime, type Track } from "@rawon/shared";
import {
    ActionRowBuilder,
    type AnySelectMenuInteraction,
    type AutocompleteInteraction,
    type ButtonInteraction,
    ChannelType,
    type ChatInputCommandInteraction,
    type Message,
    type MessageContextMenuCommandInteraction,
    MessageFlags,
    ModalBuilder,
    type ModalSubmitInteraction,
    TextInputBuilder,
    TextInputStyle,
    type VoiceBasedChannel,
} from "discord.js";
import type { CommandRegistry } from "./CommandRegistry.js";
import { DiscordVoiceTransport } from "./DiscordVoiceTransport.js";
import {
    buildFilterSelectPayload,
    buildLyricsPagePayload,
    buildNoticeContainer,
    buildQueuePagePayload,
} from "./playerUi.js";
import type {
    BotRuntimeHandle,
    BotServices,
    CommandArgsReader,
    CommandContext,
    CommandDefinition,
} from "./types.js";
import {
    canControlPlayback,
    consumePendingSelection,
    deletePendingSelection,
    getPendingLyrics,
    isDeveloperUser,
    resolvePlaybackTargetBotId,
} from "./utils/guards.js";

function createSlashArgsReader(interaction: ChatInputCommandInteraction): CommandArgsReader {
    return {
        rawArgs: [],
        getSubcommand: () => {
            try {
                return interaction.options.getSubcommand(false);
            } catch {
                return null;
            }
        },
        getString: (name) => interaction.options.getString(name),
        getInteger: (name) => interaction.options.getInteger(name),
        getBoolean: (name) => interaction.options.getBoolean(name),
        getUserId: (name) => interaction.options.getUser(name)?.id ?? null,
        getRoleId: (name) => interaction.options.getRole(name)?.id ?? null,
        getChannelId: (name) => interaction.options.getChannel(name)?.id ?? null,
        getAttachmentUrl: (name) => interaction.options.getAttachment(name)?.url ?? null,
    };
}

function parseMentionId(
    token: string | undefined,
    kind: "user" | "role" | "channel",
): string | null {
    if (!token) return null;
    if (/^\d{15,22}$/u.test(token)) return token;
    if (kind === "user") {
        const m = /^<@!?(\d{15,22})>$/u.exec(token);
        return m?.[1] ?? null;
    }
    if (kind === "role") {
        const m = /^<@&(\d{15,22})>$/u.exec(token);
        return m?.[1] ?? null;
    }
    const m = /^<#(\d{15,22})>$/u.exec(token);
    return m?.[1] ?? null;
}

function createPrefixArgsReader(args: string[], message?: Message): CommandArgsReader {
    return {
        rawArgs: args,
        getSubcommand: (pos = 0) => args[pos] ?? null,
        getString: (_name, pos = 0, joinRest = false) => {
            if (args.length <= pos) return null;
            return joinRest ? args.slice(pos).join(" ") : (args[pos] ?? null);
        },
        getInteger: (_name, pos = 0) => {
            const raw = args[pos];
            if (!raw) return null;
            const n = Number(raw);
            return Number.isInteger(n) ? n : null;
        },
        getBoolean: (_name, pos = 0) => {
            const raw = args[pos]?.toLowerCase();
            if (!raw) return null;
            if (raw === "true" || raw === "yes" || raw === "1" || raw === "on") return true;
            if (raw === "false" || raw === "no" || raw === "0" || raw === "off") return false;
            return null;
        },
        getUserId: (_name, pos = 0) => parseMentionId(args[pos], "user"),
        getRoleId: (_name, pos = 0) => parseMentionId(args[pos], "role"),
        getChannelId: (_name, pos = 0) => parseMentionId(args[pos], "channel"),
        getAttachmentUrl: () => message?.attachments.first()?.url ?? null,
    };
}

export class CommandRouter {
    private readonly registry: CommandRegistry;
    private readonly services: BotServices;
    private readonly cooldowns = new Map<string, number>();

    public constructor(registry: CommandRegistry, services: BotServices) {
        this.registry = registry;
        this.services = services;
    }

    public async handlePrefixMessage(params: {
        message: Message;
        runtime: BotRuntimeHandle;
        matchedPrefix: string;
        contentAfterPrefix: string;
    }): Promise<void> {
        const { message, runtime, matchedPrefix, contentAfterPrefix } = params;
        const parts = contentAfterPrefix.trim().split(/\s+/u).filter(Boolean);
        const cmdName = parts.shift()?.toLowerCase();
        if (!cmdName) return;

        const command = this.registry.resolveCommand(cmdName);
        if (!command) return;

        const guild = message.guild;
        const guildConfig = guild ? await this.services.store.getGuildConfig(guild.id) : null;
        const locale = this.services.i18n.resolveLocale(
            guildConfig?.locale,
            this.services.config.defaultLocale,
        );
        const t = this.services.i18n.scoped(locale);

        let sentReply: Message | null = null;
        const ctx: CommandContext = {
            source: "prefix",
            client: runtime.client,
            runtime,
            services: this.services,
            guild,
            member: message.member,
            channel: message.channel,
            userId: message.author.id,
            userTag: message.author.tag,
            locale,
            t,
            prefix: matchedPrefix,
            args: createPrefixArgsReader(parts, message),
            message,
            reply: async (payload) => {
                if (!("send" in message.channel)) return null;
                sentReply = await message
                    .reply({
                        ...(typeof payload === "string" ? { content: payload } : payload),
                        allowedMentions: { repliedUser: false },
                    } as never)
                    .catch(() => null);
                return sentReply;
            },
            editReply: async (payload) => {
                if (sentReply) {
                    await sentReply
                        .edit({
                            ...(typeof payload === "string" ? { content: payload } : payload),
                            content: typeof payload === "string" ? payload : null,
                            embeds: [],
                        } as never)
                        .catch(() => undefined);
                    return;
                }
                await ctx.reply(payload);
            },
            defer: async () => {
                if (
                    "sendTyping" in message.channel &&
                    typeof message.channel.sendTyping === "function"
                ) {
                    await message.channel.sendTyping().catch(() => undefined);
                }
            },
        };

        await this.executeWithGuards(command, ctx);
    }

    public async handleSlashCommand(
        interaction: ChatInputCommandInteraction,
        runtime: BotRuntimeHandle,
    ): Promise<void> {
        const command = this.registry.getByName(interaction.commandName);
        if (!command) return;

        const guild = interaction.guild;
        const guildConfig = guild ? await this.services.store.getGuildConfig(guild.id) : null;
        const locale = this.services.i18n.resolveLocale(
            guildConfig?.locale ?? interaction.locale,
            this.services.config.defaultLocale,
        );
        const t = this.services.i18n.scoped(locale);
        const prefix = guildConfig?.prefix ?? this.services.config.mainPrefix;

        const member =
            interaction.member && "voice" in interaction.member
                ? interaction.member
                : guild
                  ? await guild.members.fetch(interaction.user.id).catch(() => null)
                  : null;

        let repliedOrDeferred = false;
        const ctx: CommandContext = {
            source: "slash",
            client: runtime.client,
            runtime,
            services: this.services,
            guild,
            member,
            channel: interaction.channel,
            userId: interaction.user.id,
            userTag: interaction.user.tag,
            locale,
            t,
            prefix,
            args: createSlashArgsReader(interaction),
            interaction,
            reply: async (payload, ephemeral = false) => {
                const base = typeof payload === "string" ? { content: payload } : { ...payload };
                const existingFlags =
                    typeof (base as { flags?: number }).flags === "number"
                        ? (base as { flags: number }).flags
                        : 0;
                const finalFlags = ephemeral
                    ? existingFlags | MessageFlags.Ephemeral
                    : existingFlags;
                const msgOpts = { ...base, ...(finalFlags ? { flags: finalFlags } : {}) };

                if (interaction.deferred || interaction.replied) {
                    await interaction.editReply({
                        ...msgOpts,
                        content: typeof payload === "string" ? payload : null,
                        embeds: [],
                    } as never);
                    repliedOrDeferred = true;
                    return null;
                }
                await interaction.reply(msgOpts as never);
                repliedOrDeferred = true;
                return null;
            },
            editReply: async (payload) => {
                const base = typeof payload === "string" ? { content: payload } : { ...payload };
                if (!repliedOrDeferred && !interaction.deferred && !interaction.replied) {
                    await interaction.reply(base as never);
                    repliedOrDeferred = true;
                    return;
                }
                await interaction.editReply({
                    ...base,
                    content: typeof payload === "string" ? payload : null,
                    embeds: [],
                } as never);
            },
            defer: async (ephemeral = false) => {
                if (interaction.deferred || interaction.replied) return;
                await interaction.deferReply(
                    ephemeral ? { flags: MessageFlags.Ephemeral } : undefined,
                );
                repliedOrDeferred = true;
            },
        };

        await this.executeWithGuards(command, ctx);
    }

    public async handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
        const command = this.registry.getByName(interaction.commandName);
        if (!command?.autocomplete) {
            await interaction.respond([]).catch(() => undefined);
            return;
        }
        await command.autocomplete(interaction, this.services).catch(() => undefined);
    }

    public async handleMessageContextMenu(
        interaction: MessageContextMenuCommandInteraction,
        runtime: BotRuntimeHandle,
    ): Promise<void> {
        const botSettings = await this.services.store.getBotSettings();
        const guildConfig = interaction.guild
            ? await this.services.store.getGuildConfig(interaction.guild.id)
            : null;
        const locale = this.services.i18n.resolveLocale(
            guildConfig?.locale ?? interaction.locale,
            this.services.config.defaultLocale,
        );
        const t = this.services.i18n.scoped(locale);

        if (!interaction.guild) {
            await interaction.reply({
                ...buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: "This command can only be used in a server.",
                }),
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            } as never);
            return;
        }

        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const voiceChannel = member?.voice.channel as VoiceBasedChannel | null;
        if (!voiceChannel) {
            await interaction.reply({
                ...buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${t("utils.musicDecorator.noInVC")}`,
                }),
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            } as never);
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetMsg = interaction.targetMessage;
        const attachment = targetMsg.attachments.first();
        const rawQuery = targetMsg.content.trim();
        let tracks: Track[] = [];

        if (attachment?.url) {
            tracks.push({
                id: attachment.id,
                title: attachment.name ?? "Audio Attachment",
                url: attachment.url,
                duration: 0,
                thumbnail: "",
                author: "Discord Attachment",
                provider: "attachment" as const,
            });
        } else if (rawQuery) {
            const firstLine = rawQuery.split(/\r?\n/u)[0] ?? rawQuery;
            const res = await this.services.providers
                .search(firstLine, "youtube", 1, botSettings.searchProvider)
                .catch(() => null);
            if (res) {
                tracks = res.playlist ? res.items : res.items.slice(0, 1);
            }
        }

        if (tracks.length === 0) {
            await interaction.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${t("commands.music.play.noSongData")}`,
                }) as never,
            );
            return;
        }

        const session = await this.services.sessions.getOrCreateSession({
            guildId: interaction.guild.id,
            botId: runtime.botId,
            voiceChannelId: voiceChannel.id,
            textChannelId: interaction.channelId,
            createTransport: () =>
                new DiscordVoiceTransport({ client: runtime.client, logger: this.services.logger }),
        });

        await session.addAndMaybePlay({
            tracks,
            requesterId: interaction.user.id,
            requesterTag: interaction.user.tag,
        });
        await this.services.syncRequestChannelPlayer(interaction.guild.id, runtime.botId);

        const first = tracks[0];
        await interaction.editReply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${t("requestChannel.addedToQueue", {
                    song: first ? `**[${first.title}](${first.url})**` : "",
                })}`,
            }) as never,
        );
    }

    public async handleComponentInteraction(
        interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
        runtime: BotRuntimeHandle,
    ): Promise<void> {
        if (!interaction.guild) return;
        const [botSettings, guildConfig] = await Promise.all([
            this.services.store.getBotSettings(),
            this.services.store.getGuildConfig(interaction.guild.id),
        ]);
        const locale = this.services.i18n.resolveLocale(
            guildConfig.locale ?? interaction.locale,
            this.services.config.defaultLocale,
        );
        const t = this.services.i18n.scoped(locale);
        const id = interaction.customId;

        const replyEphemeral = async (msg: string) => {
            const payload = {
                ...buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: msg,
                }),
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            };
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply(payload as never).catch(() => undefined);
            } else {
                await interaction.reply(payload as never).catch(() => undefined);
            }
        };

        // 1. Volume modal open (MUST NOT defer before showModal!)
        if (interaction.isButton() && id === "rc_volume") {
            const session =
                this.services.sessions.getSession(interaction.guild.id, runtime.botId) ??
                this.services.sessions.getSessionsForGuild(interaction.guild.id)[0];
            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }
            const modal = new ModalBuilder()
                .setCustomId(`rc_volume_modal:${session.botId}`)
                .setTitle(t("requestChannel.volumeModalTitle"))
                .addComponents(
                    new ActionRowBuilder<TextInputBuilder>().addComponents(
                        new TextInputBuilder()
                            .setCustomId("volume_value")
                            .setLabel(t("requestChannel.volumeModalLabel"))
                            .setStyle(TextInputStyle.Short)
                            .setValue(String(session.getPlayerState().volume))
                            .setMinLength(1)
                            .setMaxLength(3)
                            .setRequired(true),
                    ),
                );
            await interaction.showModal(modal);
            return;
        }

        // 2. Volume modal submit
        if (interaction.isModalSubmit() && id.startsWith("rc_volume_modal:")) {
            const targetBotId = id.split(":")[1] ?? runtime.botId;
            const session = this.services.sessions.getSession(interaction.guild.id, targetBotId);
            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }
            const rawVal = interaction.fields.getTextInputValue("volume_value").trim();
            const parsed = Number(rawVal);
            if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
                await replyEphemeral(
                    `${botSettings.noEmoji} ${t("requestChannel.invalidVolumeModal")}`,
                );
                return;
            }
            await session.setVolume(Math.round(parsed));
            await this.services.syncRequestChannelPlayer(interaction.guild.id, targetBotId);
            await replyEphemeral(
                `${botSettings.yesEmoji} ${t("commands.music.volume.newVolume", { volume: `\`${Math.round(parsed)}%\`` })}`,
            );
            return;
        }

        // 3. Persistent RequestChannel / Player buttons (rc_*)
        if (interaction.isButton() && id.startsWith("rc_")) {
            const session =
                this.services.sessions.getSession(interaction.guild.id, runtime.botId) ??
                this.services.sessions.getSessionsForGuild(interaction.guild.id)[0];

            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }

            if (id === "rc_queue") {
                await interaction.reply({
                    ...buildQueuePagePayload({
                        tracks: session.queue.getAll(),
                        currentKey: session.queue.currentKey,
                        page: 1,
                        botSettings,
                        t,
                        guildId: interaction.guild.id,
                        botId: session.botId,
                    }),
                    flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
                } as never);
                return;
            }

            const member = await interaction.guild.members
                .fetch(interaction.user.id)
                .catch(() => null);
            if (!member || member.voice.channelId !== session.voiceChannelId) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.sameVC")}`);
                return;
            }

            if (
                !canControlPlayback({
                    member,
                    guildConfig,
                    currentRequesterId: session.currentTrack?.requesterId,
                    devs: this.services.config.devs,
                })
            ) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("requestChannel.noPermission")}`);
                return;
            }

            await interaction.deferUpdate();
            switch (id) {
                case "rc_prev":
                    await session.previous();
                    break;
                case "rc_pause":
                    if (session.paused) await session.resume();
                    else await session.pause();
                    break;
                case "rc_skip":
                    await session.skip();
                    break;
                case "rc_stop":
                    await session.stop({ leaveVoice: !botSettings.alwaysOn, clearQueue: true });
                    break;
                case "rc_shuffle":
                    await session.setShuffle(!session.getPlayerState().shuffle);
                    break;
                case "rc_repeat":
                    await session.cycleLoopMode();
                    break;
                case "rc_autoplay":
                    await session.setAutoplay(!session.getPlayerState().autoplay);
                    break;
            }
            await this.services.syncRequestChannelPlayer(interaction.guild.id, session.botId);
            return;
        }

        // 4. Queue pagination
        if (interaction.isButton() && id.startsWith("queue_page:")) {
            const [, targetBotId, pageStr] = id.split(":");
            const page = Math.max(1, Number.parseInt(pageStr ?? "1", 10) || 1);
            const session = this.services.sessions.getSession(
                interaction.guild.id,
                targetBotId ?? runtime.botId,
            );
            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }
            await interaction.update(
                buildQueuePagePayload({
                    tracks: session.queue.getAll(),
                    currentKey: session.queue.currentKey,
                    page,
                    botSettings,
                    t,
                    guildId: interaction.guild.id,
                    botId: session.botId,
                }) as never,
            );
            return;
        }

        // 4b. Lyrics pagination
        if (interaction.isButton() && id.startsWith("lyrics_page:")) {
            const [, ownerId, pageStr] = id.split(":");
            const page = Math.max(1, Number.parseInt(pageStr ?? "1", 10) || 1);
            const lyrics = getPendingLyrics(ownerId ?? "");
            if (!lyrics) {
                await replyEphemeral(
                    `${botSettings.noEmoji} Lyrics session expired; please run the command again.`,
                );
                return;
            }
            await interaction.update(
                buildLyricsPagePayload({
                    lyrics,
                    page,
                    botSettings,
                    t,
                    ownerId: ownerId ?? interaction.user.id,
                }) as never,
            );
            return;
        }

        // 5. Filter panel interactions
        if (interaction.isStringSelectMenu() && id.startsWith("filter_toggle:")) {
            const targetBotId = id.split(":")[1] ?? runtime.botId;
            const session = this.services.sessions.getSession(interaction.guild.id, targetBotId);
            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }
            const chosen = interaction.values[0];
            if (chosen) {
                await session.toggleFilter(chosen as Parameters<typeof session.toggleFilter>[0]);
                await this.services.syncRequestChannelPlayer(interaction.guild.id, targetBotId);
            }
            await interaction.update(
                buildFilterSelectPayload({
                    activeFilters: session.getPlayerState().filters,
                    botSettings,
                    t,
                    botId: session.botId,
                }) as never,
            );
            return;
        }

        if (interaction.isButton() && id.startsWith("filter_reset:")) {
            const targetBotId = id.split(":")[1] ?? runtime.botId;
            const session = this.services.sessions.getSession(interaction.guild.id, targetBotId);
            if (!session) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noQueue")}`);
                return;
            }
            await session.resetFilters();
            await this.services.syncRequestChannelPlayer(interaction.guild.id, targetBotId);
            await interaction.update(
                buildFilterSelectPayload({
                    activeFilters: session.getPlayerState().filters,
                    botSettings,
                    t,
                    botId: session.botId,
                }) as never,
            );
            return;
        }

        // 6. Search selection & cancellation
        if (interaction.isStringSelectMenu() && id.startsWith("search_select:")) {
            const selId = id.split(":")[1] ?? "";
            const entry = consumePendingSelection(selId);
            if (!entry) {
                await replyEphemeral(`${botSettings.noEmoji} Selection expired.`);
                return;
            }
            if (entry.userId !== interaction.user.id) {
                await replyEphemeral(
                    t("events.createInteraction.message1", { user: entry.userId }),
                );
                return;
            }
            const idx = Number.parseInt(interaction.values[0] ?? "0", 10);
            const track = entry.tracks[idx];
            deletePendingSelection(selId);
            if (!track) return;

            const member = await interaction.guild.members
                .fetch(interaction.user.id)
                .catch(() => null);
            const vc = member?.voice.channel as VoiceBasedChannel | null;
            if (!vc) {
                await replyEphemeral(`${botSettings.noEmoji} ${t("utils.musicDecorator.noInVC")}`);
                return;
            }

            const session = await this.services.sessions.getOrCreateSession({
                guildId: interaction.guild.id,
                botId: runtime.botId,
                voiceChannelId: vc.id,
                textChannelId: interaction.channelId ?? vc.id,
                createTransport: () =>
                    new DiscordVoiceTransport({
                        client: runtime.client,
                        logger: this.services.logger,
                    }),
            });
            await session.addAndMaybePlay({
                tracks: [track],
                requesterId: interaction.user.id,
                requesterTag: interaction.user.tag,
            });
            await this.services.syncRequestChannelPlayer(interaction.guild.id, runtime.botId);

            await interaction.update(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${t("requestChannel.addedToQueue", {
                        song: `**[${track.title}](${track.url})**`,
                    })}`,
                }) as never,
            );
            return;
        }

        if (interaction.isButton() && id.startsWith("search_cancel:")) {
            const selId = id.split(":")[1] ?? "";
            const entry = consumePendingSelection(selId);
            if (entry && entry.userId !== interaction.user.id) {
                await replyEphemeral(
                    t("events.createInteraction.message1", { user: entry.userId }),
                );
                return;
            }
            deletePendingSelection(selId);
            await interaction.update(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: t("commands.music.search.canceledMessage"),
                }) as never,
            );
            return;
        }

        // 7. Help select menu
        if (interaction.isStringSelectMenu() && id.startsWith("help_cmd:")) {
            const cmdName = interaction.values[0];
            const cmd = cmdName ? this.registry.getByName(cmdName) : undefined;
            if (!cmd) return;
            const prefix = guildConfig.prefix ?? this.services.config.mainPrefix;
            const aliases =
                cmd.aliases && cmd.aliases.length > 0
                    ? cmd.aliases.map((a) => `\`${a}\``).join(", ")
                    : t("commands.general.help.noAliases");
            const usage = cmd.usage
                ? t(cmd.usage, { prefix, options: "queue | song | off" })
                : `${prefix}${cmd.name}`;

            await interaction.reply({
                ...buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: t("commands.general.help.commandDetailTitle", {
                        username: runtime.client.user?.username ?? "Rawon",
                        command: cmd.name,
                    }),
                    description: [
                        `**${t("commands.general.help.nameString")}:** \`${cmd.name}\``,
                        `**${t("commands.general.help.descriptionString")}:** ${t(cmd.descriptionKey)}`,
                        `**${t("commands.general.help.aliasesString")}:** ${aliases}`,
                        `**${t("commands.general.help.usageString")}:** \`${usage}\``,
                    ].join("\n"),
                }),
                flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            } as never);
        }
    }

    private async executeWithGuards(
        command: CommandDefinition,
        ctx: CommandContext,
    ): Promise<void> {
        const botSettings = await ctx.services.store.getBotSettings();
        const guards = command.guards ?? {};

        if (guards.devOnly && !isDeveloperUser(ctx.userId, ctx.services.config.devs)) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("events.createInteraction.devOnly")}`,
                }),
                true,
            );
            return;
        }

        if (guards.guildOnly && !ctx.guild) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} This command can only be used inside a server.`,
                }),
                true,
            );
            return;
        }

        // Per-user cooldown
        const cdMs = command.cooldownMs ?? 1_500;
        if (cdMs > 0 && !isDeveloperUser(ctx.userId, ctx.services.config.devs)) {
            const cdKey = `${command.name}:${ctx.userId}`;
            const now = Date.now();
            const until = this.cooldowns.get(cdKey) ?? 0;
            if (until > now) {
                const leftSec = Math.max(1, Math.ceil((until - now) / 1000));
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: ctx.t("utils.cooldownMessage", {
                            author: `<@${ctx.userId}>`,
                            timeleft: normalizeTime(leftSec),
                        }),
                    }),
                    true,
                );
                return;
            }
            this.cooldowns.set(cdKey, now + cdMs);
        }

        if (ctx.guild) {
            const targetBotId = resolvePlaybackTargetBotId(ctx);
            const activeSession =
                ctx.services.sessions.getSession(ctx.guild.id, targetBotId) ??
                ctx.services.sessions.getSessionsForGuild(ctx.guild.id)[0];
            ctx.activeSession = activeSession;

            if (guards.inVoiceChannel && !ctx.member?.voice.channelId) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.noInVC")}`,
                    }),
                    true,
                );
                return;
            }

            if (guards.requireActiveSession && !activeSession) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.noQueue")}`,
                    }),
                    true,
                );
                return;
            }

            if (guards.requireCurrentTrack && !activeSession?.currentTrack) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.notPlaying")}`,
                    }),
                    true,
                );
                return;
            }

            if (
                guards.sameVoiceChannel &&
                activeSession &&
                ctx.member?.voice.channelId &&
                ctx.member.voice.channelId !== activeSession.voiceChannelId
            ) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("utils.musicDecorator.sameVC")}`,
                    }),
                    true,
                );
                return;
            }

            // Warn users using non-request text commands inside the request channel except rc/stop
            if (
                ctx.channel &&
                ctx.channel.type !== ChannelType.DM &&
                command.name !== "requestchannel"
            ) {
                const rc = await ctx.services.store.getRequestChannel(
                    ctx.guild.id,
                    ctx.runtime.botId,
                );
                if (rc && rc.channelId === ctx.channel.id && ctx.source === "prefix") {
                    await ctx.reply(
                        buildNoticeContainer({
                            colorHex: botSettings.embedColor,
                            description: ctx.t("utils.musicDecorator.useRequestChannelDirect"),
                        }),
                        true,
                    );
                    return;
                }
            }
        }

        try {
            await command.execute(ctx);
        } catch (err) {
            ctx.services.logger.error(
                { err, command: command.name, guildId: ctx.guild?.id },
                "Unhandled error executing command",
            );
            await ctx
                .reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${err instanceof Error ? err.message : String(err)}`,
                    }),
                    true,
                )
                .catch(() => undefined);
        }
    }
}
