import type { AudioPipeline } from "@rawon/audio-engine";
import type { DiskAudioCache, PrefetchCoordinator } from "@rawon/cache";
import type { I18nService, RawonConfig } from "@rawon/config";
import type { BotHeartbeatInfo, CoordinatorService, DatabaseStore } from "@rawon/database";
import type { SessionManager } from "@rawon/music-core";
import type { ProviderRegistry } from "@rawon/providers";
import { type Logger, redactSensitiveText } from "@rawon/shared";
import {
    ActivityType,
    Client,
    Events,
    GatewayIntentBits,
    type Guild,
    REST,
    Routes,
    type VoiceBasedChannel,
} from "discord.js";
import { CommandRegistry } from "./CommandRegistry.js";
import { CommandRouter } from "./CommandRouter.js";
import { CookieStore, parseNetscapeCookieEntries } from "./CookieStore.js";
import { DiscordVoiceTransport } from "./DiscordVoiceTransport.js";
import { GoogleLoginService } from "./GoogleLoginService.js";
import { buildNoticeContainer } from "./playerUi.js";
import { RequestChannelService } from "./RequestChannelService.js";
import type { BotRuntimeHandle, BotServices } from "./types.js";
import { deletePendingSelection, findPendingSelectionForUser } from "./utils/guards.js";

function mapActivityType(raw: string): ActivityType {
    const upper = raw.trim().toUpperCase();
    switch (upper) {
        case "LISTENING":
            return ActivityType.Listening;
        case "WATCHING":
            return ActivityType.Watching;
        case "COMPETING":
            return ActivityType.Competing;
        case "STREAMING":
            return ActivityType.Streaming;
        default:
            return ActivityType.Playing;
    }
}

export class MultiBotSupervisor {
    private readonly config: RawonConfig;
    private readonly store: DatabaseStore;
    private readonly coordinator: CoordinatorService;
    private readonly providers: ProviderRegistry;
    private readonly audioPipeline: AudioPipeline;
    private readonly diskCache: DiskAudioCache;
    private readonly prefetch: PrefetchCoordinator;
    private readonly sessions: SessionManager;
    private readonly i18n: I18nService;
    private readonly logger: Logger;

    private readonly registry = new CommandRegistry();
    private readonly cookieStore: CookieStore;
    private loginService: GoogleLoginService | null = null;
    private readonly router: CommandRouter;
    private readonly requestChannels: RequestChannelService;
    private readonly runtimes: BotRuntimeHandle[] = [];
    private readonly services: BotServices;

    private heartbeatTimer: NodeJS.Timeout | null = null;
    private activityTimer: NodeJS.Timeout | null = null;
    private activityIndex = 0;

    public constructor(options: {
        config: RawonConfig;
        store: DatabaseStore;
        coordinator: CoordinatorService;
        providers: ProviderRegistry;
        audioPipeline: AudioPipeline;
        diskCache: DiskAudioCache;
        prefetch: PrefetchCoordinator;
        sessions: SessionManager;
        i18n: I18nService;
        logger: Logger;
    }) {
        this.config = options.config;
        this.store = options.store;
        this.coordinator = options.coordinator;
        this.providers = options.providers;
        this.audioPipeline = options.audioPipeline;
        this.diskCache = options.diskCache;
        this.prefetch = options.prefetch;
        this.sessions = options.sessions;
        this.i18n = options.i18n;
        this.logger = options.logger;

        this.cookieStore = new CookieStore({
            dataDir: options.config.dataDir,
            encryptionKey: options.config.cookiesEncryptionKey,
        });

        const restoredCookies = this.cookieStore.restoreFromEncryptedIfNeeded();
        if (restoredCookies) {
            this.providers.ytdlp.setCookiesPath(restoredCookies);
        }

        if (options.config.youtubeCookies) {
            const envEntries = parseNetscapeCookieEntries(options.config.youtubeCookies);
            if (envEntries.length > 0) {
                const saved = this.cookieStore.saveCookies(envEntries);
                this.providers.ytdlp.setCookiesPath(saved.cookiesPath);
                this.logger.info(
                    { cookieCount: saved.count },
                    "Loaded YouTube cookies from YOUTUBE_COOKIES environment configuration",
                );
            } else {
                this.logger.warn(
                    "YOUTUBE_COOKIES was provided but did not contain valid Netscape cookie entries",
                );
            }
        }

        this.requestChannels = new RequestChannelService({
            store: this.store,
            coordinator: this.coordinator,
            providers: this.providers,
            sessions: this.sessions,
            logger: this.logger,
        });

        this.services = {
            config: this.config,
            store: this.store,
            coordinator: this.coordinator,
            providers: this.providers,
            audioPipeline: this.audioPipeline,
            diskCache: this.diskCache,
            prefetch: this.prefetch,
            sessions: this.sessions,
            i18n: this.i18n,
            logger: this.logger,
            getBotRuntimes: () => this.runtimes,
            getActiveBotCount: () => this.runtimes.length,
            getOrCreateGoogleLoginService: () => {
                if (!this.loginService) {
                    this.loginService = new GoogleLoginService({
                        store: this.store,
                        cookieStore: this.cookieStore,
                        ytdlp: this.providers.ytdlp,
                        devtoolsPort: this.config.devtoolsPort,
                        chromiumPath: this.config.chromiumPath,
                        logger: this.logger,
                    });
                }
                return this.loginService;
            },
            getCookieStore: () => this.cookieStore,
            syncRequestChannelPlayer: async (guildId, botId) => {
                const rt = this.runtimes.find((r) => r.botId === botId) ?? this.runtimes[0];
                if (!rt) return;
                const [botSettings, guildConfig] = await Promise.all([
                    this.store.getBotSettings(),
                    this.store.getGuildConfig(guildId),
                ]);
                const loc = this.i18n.resolveLocale(guildConfig.locale, this.config.defaultLocale);
                await this.requestChannels.syncPlayerMessage({
                    client: rt.client,
                    guildId,
                    botId,
                    botSettings,
                    t: this.i18n.scoped(loc),
                });
            },
            registerSlashCommandsForBot: (botId) => this.registerSlashCommands(botId),
        };

        this.router = new CommandRouter(this.registry, this.services);

        // Subscribe to cross-instance events (e.g., setup settings update)
        this.coordinator.onEvent((evt) => {
            if (evt.type === "settings_updated") {
                void this.store
                    .getBotSettings()
                    .then((bs) => this.sessions.refreshBotSettings(bs))
                    .catch(() => undefined);
            }
        });

        // Sync Request Channel persistent player UI and surface terminal playback errors
        this.sessions.on(
            "sessionCreated",
            (session: import("@rawon/music-core").GuildMusicSession) => {
                session.on("stateUpdate", () => {
                    const rt = this.runtimes.find((r) => r.botId === session.botId);
                    if (!rt) return;
                    void (async () => {
                        const [bs, gCfg] = await Promise.all([
                            this.store.getBotSettings(),
                            this.store.getGuildConfig(session.guildId),
                        ]);
                        const loc = this.i18n.resolveLocale(gCfg.locale, this.config.defaultLocale);
                        this.requestChannels.schedulePlayerSync({
                            client: rt.client,
                            guildId: session.guildId,
                            botId: session.botId,
                            botSettings: bs,
                            t: this.i18n.scoped(loc),
                        });
                    })();
                });

                session.on("notice", (notice) => {
                    if (notice.level !== "error" || !session.textChannelId) return;
                    const rt = this.runtimes.find((r) => r.botId === session.botId);
                    if (!rt) return;
                    void (async () => {
                        try {
                            const [bs, gCfg, rcCfg, channel] = await Promise.all([
                                this.store.getBotSettings(),
                                this.store.getGuildConfig(session.guildId),
                                this.store.getRequestChannel(session.guildId, session.botId),
                                rt.client.channels.fetch(session.textChannelId).catch(() => null),
                            ]);
                            if (!channel?.isTextBased() || !("send" in channel)) return;

                            const loc = this.i18n.resolveLocale(
                                gCfg.locale,
                                this.config.defaultLocale,
                            );
                            const t = this.i18n.scoped(loc);
                            const safeParams: Record<string, string | number | undefined> = {};
                            for (const [k, v] of Object.entries(notice.params ?? {})) {
                                if (typeof v === "string") {
                                    safeParams[k] = redactSensitiveText(
                                        v,
                                        this.config.discordTokens,
                                    ).slice(0, 240);
                                } else if (typeof v === "number") {
                                    safeParams[k] = v;
                                } else if (typeof v === "boolean") {
                                    safeParams[k] = String(v);
                                }
                            }

                            const msg = await channel.send(
                                buildNoticeContainer({
                                    colorHex: bs.embedColor,
                                    description: `${bs.noEmoji} ${t(notice.key, safeParams)}`,
                                }) as never,
                            );
                            if (rcCfg?.channelId === session.textChannelId) {
                                setTimeout(() => {
                                    void msg.delete().catch(() => undefined);
                                }, 12_000).unref?.();
                            }
                        } catch (err) {
                            this.logger.debug(
                                { err, guildId: session.guildId, code: notice.code },
                                "Failed to dispatch session error notice",
                            );
                        }
                    })();
                });
            },
        );
    }

    public async start(): Promise<void> {
        if (this.config.discordTokens.length === 0) {
            throw new Error("DISCORD_TOKEN is empty; at least one Discord bot token is required.");
        }

        const startTimes = new Map<number, number>();

        for (let tokenIndex = 0; tokenIndex < this.config.discordTokens.length; tokenIndex++) {
            const token = this.config.discordTokens[tokenIndex];
            if (!token) continue;

            const client = new Client({
                intents: [
                    GatewayIntentBits.Guilds,
                    GatewayIntentBits.GuildVoiceStates,
                    GatewayIntentBits.GuildMessages,
                    GatewayIntentBits.MessageContent,
                ],
            });

            const runtime: BotRuntimeHandle = {
                botId: `pending-${tokenIndex}`,
                tokenIndex,
                client,
                tag: `Bot#${tokenIndex + 1}`,
                getUptimeMs: () => Date.now() - (startTimes.get(tokenIndex) ?? Date.now()),
                pickBestBotForGuild: (guildId, vcId) =>
                    this.pickBestBotForGuild(guildId, vcId, runtime),
            };
            this.runtimes.push(runtime);

            this.attachClientListeners(client, runtime, startTimes);
            await client.login(token);
        }

        this.heartbeatTimer = setInterval(() => {
            void this.publishAllHeartbeats().catch(() => undefined);
        }, 5_000);
        this.heartbeatTimer.unref?.();

        this.activityTimer = setInterval(() => {
            this.rotateActivities();
        }, 30_000);
        this.activityTimer.unref?.();
    }

    public async shutdown(): Promise<void> {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.activityTimer) {
            clearInterval(this.activityTimer);
            this.activityTimer = null;
        }
        if (this.loginService) {
            await this.loginService.stopBrowser().catch(() => undefined);
        }
        await this.sessions.destroyAll("shutdown");
        for (const rt of this.runtimes) {
            rt.client.destroy();
        }
        this.runtimes.length = 0;
    }

    private attachClientListeners(
        client: Client,
        runtime: BotRuntimeHandle,
        startTimes: Map<number, number>,
    ): void {
        client.once(Events.ClientReady, async (readyClient) => {
            runtime.botId = readyClient.user.id;
            runtime.tag = readyClient.user.tag;
            startTimes.set(runtime.tokenIndex, Date.now());
            this.logger.info(
                { botId: runtime.botId, tag: runtime.tag, guilds: readyClient.guilds.cache.size },
                "Discord bot logged in and ready",
            );

            await this.publishBotHeartbeat(runtime);

            if (this.config.enableSlashCommand) {
                await this.registerSlashCommands(runtime.botId).catch((err) => {
                    this.logger.warn(
                        { err, botId: runtime.botId },
                        "Failed registering slash commands",
                    );
                });
            }

            await this.cleanupOrphansAndRestoreSessions(runtime).catch((err) => {
                this.logger.warn({ err, botId: runtime.botId }, "Startup restore/cleanup error");
            });

            this.rotateActivities();
        });

        client.on(Events.MessageCreate, async (message) => {
            try {
                if (message.author.bot) return;

                // 0. Check text-based track selection reply ("1", "1 3", or "cancel"/"c")
                if (message.guild) {
                    const pending = findPendingSelectionForUser(
                        message.guild.id,
                        message.channelId,
                        message.author.id,
                    );
                    if (pending) {
                        const text = message.content.trim().toLowerCase();
                        if (/^(?:\d+(?:[\s,]+\d+)*|c|cancel)$/u.test(text)) {
                            const [botSettings, guildCfg] = await Promise.all([
                                this.store.getBotSettings(),
                                this.store.getGuildConfig(message.guild.id),
                            ]);
                            const loc = this.i18n.resolveLocale(
                                guildCfg.locale,
                                this.config.defaultLocale,
                            );
                            const t = this.i18n.scoped(loc);
                            deletePendingSelection(pending.id);

                            if (text === "c" || text === "cancel") {
                                await message
                                    .reply(
                                        buildNoticeContainer({
                                            colorHex: botSettings.embedColor,
                                            description: t("commands.music.search.canceledMessage"),
                                        }) as never,
                                    )
                                    .catch(() => undefined);
                                return;
                            }

                            const indices = Array.from(
                                new Set(
                                    text
                                        .split(/[\s,]+/u)
                                        .map((s) => Number.parseInt(s, 10) - 1)
                                        .filter((i) => i >= 0 && i < pending.tracks.length),
                                ),
                            );
                            const chosen = indices
                                .map((i) => pending.tracks[i])
                                .filter((tr): tr is NonNullable<typeof tr> => Boolean(tr));

                            const vc = message.member?.voice.channel as VoiceBasedChannel | null;
                            if (!vc || chosen.length === 0) {
                                await message
                                    .reply(
                                        buildNoticeContainer({
                                            colorHex: botSettings.embedColor,
                                            description: `${botSettings.noEmoji} ${t(vc ? "commands.music.search.noSelection" : "utils.musicDecorator.noInVC")}`,
                                        }) as never,
                                    )
                                    .catch(() => undefined);
                                return;
                            }

                            const session = await this.sessions.getOrCreateSession({
                                guildId: message.guild.id,
                                botId: runtime.botId,
                                voiceChannelId: vc.id,
                                textChannelId: message.channelId,
                                createTransport: () =>
                                    new DiscordVoiceTransport({
                                        client: runtime.client,
                                        logger: this.logger,
                                    }),
                            });
                            await session.addAndMaybePlay({
                                tracks: chosen,
                                requesterId: message.author.id,
                                requesterTag: message.author.tag,
                            });
                            await this.services
                                .syncRequestChannelPlayer(message.guild.id, runtime.botId)
                                .catch(() => undefined);
                            const first = chosen[0];
                            await message
                                .reply(
                                    buildNoticeContainer({
                                        colorHex: botSettings.embedColor,
                                        description: `${botSettings.yesEmoji} ${
                                            chosen.length === 1 && first
                                                ? t("requestChannel.addedToQueue", {
                                                      song: `**[${first.title}](${first.url})**`,
                                                  })
                                                : t("utils.generalHandler.handleVideoInitial", {
                                                      length: chosen.length,
                                                  })
                                        }`,
                                    }) as never,
                                )
                                .catch(() => undefined);
                            return;
                        }
                    }
                }

                // 1. Check Hydra request channel ownership for THIS specific bot
                if (message.guild) {
                    const botSettings = await this.store.getBotSettings();
                    const guildCfg = await this.store.getGuildConfig(message.guild.id);
                    const loc = this.i18n.resolveLocale(guildCfg.locale, this.config.defaultLocale);
                    const t = this.i18n.scoped(loc);
                    const basePrefix = guildCfg.prefix ?? this.config.mainPrefix;
                    const prefixes = [basePrefix, ...botSettings.altPrefix];

                    const handledAsRequest = await this.requestChannels.handleMessage({
                        message,
                        runtime,
                        botPrefixes: prefixes,
                        t,
                    });
                    if (handledAsRequest) return;
                }

                if (!this.config.enablePrefix) return;

                // 2. Prefix / Mention check
                const botSettings = await this.store.getBotSettings();
                const guildCfg = message.guild
                    ? await this.store.getGuildConfig(message.guild.id)
                    : null;
                const basePrefix = guildCfg?.prefix ?? this.config.mainPrefix;
                const candidatePrefixes = [basePrefix, ...botSettings.altPrefix].filter(Boolean);
                const mentionPfx = `<@${runtime.botId}>`;
                const mentionNickPfx = `<@!${runtime.botId}>`;

                let matchedPrefix: string | null = null;
                let explicitMentionTarget = false;

                if (message.content.startsWith(mentionPfx)) {
                    matchedPrefix = mentionPfx;
                    explicitMentionTarget = true;
                } else if (message.content.startsWith(mentionNickPfx)) {
                    matchedPrefix = mentionNickPfx;
                    explicitMentionTarget = true;
                } else {
                    for (const p of candidatePrefixes) {
                        if (message.content.startsWith(p)) {
                            matchedPrefix = p;
                            break;
                        }
                    }
                }

                if (!matchedPrefix) {
                    return;
                }

                const rest = message.content.slice(matchedPrefix.length).trim();
                if (!rest && explicitMentionTarget && message.guild) {
                    const loc = this.i18n.resolveLocale(
                        guildCfg?.locale,
                        this.config.defaultLocale,
                    );
                    const isPrimary = await this.isPrimaryForGuild(message.guild.id, runtime.botId);
                    if (!isPrimary) return;
                    const t = this.i18n.scoped(loc);
                    await message
                        .reply(
                            t("events.createMessage", {
                                author: `<@${message.author.id}>`,
                                prefix: `\`${basePrefix}\``,
                            }),
                        )
                        .catch(() => undefined);
                    return;
                }

                // Multi-bot coordination: only elected primary executes non-mention prefix commands
                if (message.guild && !explicitMentionTarget && this.runtimes.length > 1) {
                    const isPrimary = await this.isPrimaryForGuild(message.guild.id, runtime.botId);
                    if (!isPrimary) return;
                }

                await this.router.handlePrefixMessage({
                    message,
                    runtime,
                    matchedPrefix,
                    contentAfterPrefix: rest,
                });
            } catch (err) {
                this.logger.error(
                    {
                        err,
                        botId: runtime.botId,
                        guildId: message.guildId,
                        channelId: message.channelId,
                    },
                    "Unhandled error in MessageCreate handler",
                );
            }
        });

        client.on(Events.MessageDelete, (msg) => {
            if (msg.guildId && msg.channelId) {
                void this.requestChannels
                    .handleMessageDelete(msg.guildId, msg.channelId, msg.id)
                    .catch(() => undefined);
            }
        });

        client.on(Events.InteractionCreate, async (interaction) => {
            try {
                if (interaction.isChatInputCommand()) {
                    await this.router.handleSlashCommand(interaction, runtime);
                } else if (interaction.isAutocomplete()) {
                    await this.router.handleAutocomplete(interaction);
                } else if (interaction.isMessageContextMenuCommand()) {
                    await this.router.handleMessageContextMenu(interaction, runtime);
                } else if (
                    interaction.isButton() ||
                    interaction.isStringSelectMenu() ||
                    interaction.isModalSubmit()
                ) {
                    await this.router.handleComponentInteraction(interaction, runtime);
                }
            } catch (err) {
                this.logger.error(
                    {
                        err,
                        botId: runtime.botId,
                        guildId: interaction.guildId,
                        interactionId: interaction.id,
                    },
                    "Unhandled error in InteractionCreate handler",
                );
            }
        });

        client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
            try {
                const guildId = newState.guild.id;
                const session = this.sessions.getSession(guildId, runtime.botId);
                if (!session) return;

                const changedUserId = newState.id;
                if (changedUserId === runtime.botId) {
                    // Bot left/kicked from VC
                    if (!newState.channelId) {
                        await session.destroy("bot_disconnected");
                        await this.services
                            .syncRequestChannelPlayer(guildId, runtime.botId)
                            .catch(() => undefined);
                        return;
                    }
                    // Bot moved to another VC (or region/stage promotion changed)
                    if (oldState.channelId !== newState.channelId) {
                        await session.moveVoiceChannel(newState.channelId);
                    }
                    const transport = new DiscordVoiceTransport({ client, logger: this.logger });
                    await transport.ensureStageSpeaker(guildId, newState.channelId);
                }

                if (
                    oldState.channelId === session.voiceChannelId ||
                    newState.channelId === session.voiceChannelId
                ) {
                    const transport = new DiscordVoiceTransport({ client, logger: this.logger });
                    const members = await transport.getVoiceChannelMembers(
                        guildId,
                        session.voiceChannelId,
                    );
                    session.handleVoiceMembersUpdate(members);
                }
            } catch (err) {
                this.logger.error(
                    { err, botId: runtime.botId, guildId: newState.guild.id },
                    "Unhandled error in VoiceStateUpdate handler",
                );
            }
        });

        client.on(Events.GuildDelete, (guild: Guild) => {
            const session = this.sessions.getSession(guild.id, runtime.botId);
            if (session) {
                void session.destroy("guild_removed").catch(() => undefined);
            }
        });

        client.on(Events.Warn, (warn) => {
            this.logger.warn(
                { botId: runtime.botId },
                redactSensitiveText(warn, this.config.discordTokens),
            );
        });

        client.on(Events.Error, (err) => {
            this.logger.error({ err, botId: runtime.botId }, "Discord client error");
        });

        if (this.config.debugMode) {
            client.on(Events.Debug, (info) => {
                this.logger.debug(
                    { botId: runtime.botId },
                    redactSensitiveText(info, this.config.discordTokens),
                );
            });
        }
    }

    private async isPrimaryForGuild(guildId: string, candidateBotId: string): Promise<boolean> {
        const present: BotHeartbeatInfo[] = this.runtimes
            .filter((r) => r.client.guilds.cache.has(guildId) && !r.botId.startsWith("pending-"))
            .map((r) => ({
                botId: r.botId,
                tokenIndex: r.tokenIndex,
                tag: r.tag,
                guildIds: [],
                activeVoiceSessions: this.sessions.getSessionsForBot(r.botId).length,
                updatedAt: Date.now(),
            }));
        if (present.length === 0) return true;
        const primaryId = await this.coordinator.electPrimaryBot(guildId, present);
        return primaryId === candidateBotId;
    }

    private async pickBestBotForGuild(
        guildId: string,
        userVcId: string | null | undefined,
        fallback: BotRuntimeHandle,
    ): Promise<BotRuntimeHandle> {
        const sessions = this.sessions.getSessionsForGuild(guildId);
        if (userVcId) {
            const matching = sessions.find((s) => s.voiceChannelId === userVcId);
            if (matching) {
                return this.runtimes.find((r) => r.botId === matching.botId) ?? fallback;
            }
        }
        for (const rt of this.runtimes) {
            if (!rt.client.guilds.cache.has(guildId)) continue;
            if (!this.sessions.getSession(guildId, rt.botId)) {
                return rt;
            }
        }
        return fallback;
    }

    private async registerSlashCommands(botId: string): Promise<number> {
        const rt = this.runtimes.find((r) => r.botId === botId);
        const token = rt ? this.config.discordTokens[rt.tokenIndex] : undefined;
        if (!token) return 0;

        const rest = new REST({ version: "10" }).setToken(token);
        const body = this.registry.buildApplicationCommandsJson(this.i18n);

        if (this.config.isDev && this.config.mainServer) {
            await rest.put(Routes.applicationGuildCommands(botId, this.config.mainServer), {
                body,
            });
        } else {
            await rest.put(Routes.applicationCommands(botId), { body });
        }
        return body.length;
    }

    private async cleanupOrphansAndRestoreSessions(runtime: BotRuntimeHandle): Promise<void> {
        const botSettings = await this.store.getBotSettings();

        // Clear stale voice channel statuses from crashed runs
        const staleStatuses = await this.store.listVoiceChannelStatusesForBot(runtime.botId);
        for (const st of staleStatuses) {
            const transport = new DiscordVoiceTransport({
                client: runtime.client,
                logger: this.logger,
            });
            await transport
                .setVoiceChannelStatus(st.guildId, st.channelId, null)
                .catch(() => undefined);
            await this.store
                .deleteVoiceChannelStatus(st.guildId, runtime.botId)
                .catch(() => undefined);
        }

        // Refresh request channel player messages
        const rcs = await this.store.getAllRequestChannelsForBot(runtime.botId);
        for (const rc of rcs) {
            const gCfg = await this.store.getGuildConfig(rc.guildId);
            const loc = this.i18n.resolveLocale(gCfg.locale, this.config.defaultLocale);
            await this.requestChannels
                .syncPlayerMessage({
                    client: runtime.client,
                    guildId: rc.guildId,
                    botId: runtime.botId,
                    botSettings,
                    t: this.i18n.scoped(loc),
                })
                .catch(() => undefined);
        }

        // Restore persisted queue sessions cleanly (if voice channel still exists)
        const savedQueues = await this.store.listQueueSessionsForBot(runtime.botId);
        for (const persisted of savedQueues) {
            const guild = runtime.client.guilds.cache.get(persisted.guildId);
            const vc = guild?.channels.cache.get(persisted.voiceChannelId);
            if (!guild || !vc) {
                await this.store
                    .deleteQueueSession(persisted.guildId, runtime.botId)
                    .catch(() => undefined);
                continue;
            }
            try {
                const session = await this.sessions.getOrCreateSession({
                    guildId: persisted.guildId,
                    botId: runtime.botId,
                    voiceChannelId: persisted.voiceChannelId,
                    textChannelId: persisted.textChannelId,
                    createTransport: () =>
                        new DiscordVoiceTransport({ client: runtime.client, logger: this.logger }),
                });

                await session.restoreSession(persisted);
            } catch (err) {
                this.logger.warn(
                    { err, guildId: persisted.guildId },
                    "Failed restoring persisted queue session",
                );
            }
        }
    }

    private async publishAllHeartbeats(): Promise<void> {
        await Promise.all(this.runtimes.map((rt) => this.publishBotHeartbeat(rt)));
    }

    private async publishBotHeartbeat(runtime: BotRuntimeHandle): Promise<void> {
        if (runtime.botId.startsWith("pending-")) return;
        await this.coordinator.registerBotHeartbeat({
            botId: runtime.botId,
            tokenIndex: runtime.tokenIndex,
            tag: runtime.tag,
            guildIds: Array.from(runtime.client.guilds.cache.keys()),
            activeVoiceSessions: this.sessions.getSessionsForBot(runtime.botId).length,
            updatedAt: Date.now(),
        });
    }

    private rotateActivities(): void {
        if (this.config.activities.length === 0) return;
        const idx = this.activityIndex % this.config.activities.length;
        this.activityIndex += 1;

        const template = this.config.activities[idx] ?? "music";
        const typeStr =
            this.config.activityTypes[idx % this.config.activityTypes.length] ?? "PLAYING";
        const actType = mapActivityType(typeStr);

        const totalGuilds = this.runtimes.reduce((s, r) => s + r.client.guilds.cache.size, 0);
        const totalSessions = this.sessions.getActiveCount();
        const text = template
            .replaceAll("{totalGuilds}", String(totalGuilds))
            .replaceAll("{activeSessions}", String(totalSessions));

        for (const rt of this.runtimes) {
            rt.client.user?.setActivity({ name: text, type: actType });
        }
    }
}
