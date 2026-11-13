import type { ScopedTranslator } from "@rawon/config";
import type { CoordinatorService, DatabaseStore } from "@rawon/database";
import type { SessionManager } from "@rawon/music-core";
import type { ProviderRegistry } from "@rawon/providers";
import type { BotSettings, GuildConfig, Logger, Track } from "@rawon/shared";
import {
    ChannelType,
    type Client,
    type Message,
    PermissionsBitField,
    type TextBasedChannel,
} from "discord.js";
import { DiscordVoiceTransport } from "./DiscordVoiceTransport.js";
import {
    buildNoticeContainer,
    buildPersistentPlayerPayload,
    PlayerMessageUpdater,
} from "./playerUi.js";
import type { BotRuntimeHandle } from "./types.js";

const AUDIO_ATTACHMENT_RE = /\.(mp3|ogg|opus|flac|wav|m4a|aac|weba|webm|mp4)(\?|$)/iu;

export interface ParsedRequestMessage {
    queries: string[];
    attachmentTracks: Track[];
    ignoredReason?:
        | "bot"
        | "empty"
        | "excluded_prefix"
        | "excluded_user"
        | "excluded_role"
        | "too_long";
}

export function extractRequestPayloadFromMessage(params: {
    content: string;
    isBot: boolean;
    authorId: string;
    roleIds: readonly string[];
    attachments: Array<{
        id: string;
        name?: string | null;
        url: string;
        contentType?: string | null;
        size: number;
    }>;
    botPrefixes: readonly string[];
    guildConfig: GuildConfig;
}): ParsedRequestMessage {
    if (params.isBot) {
        return { queries: [], attachmentTracks: [], ignoredReason: "bot" };
    }

    const exclusions = params.guildConfig.rcExclusions;
    if (exclusions.ignoredUserIds.includes(params.authorId)) {
        return { queries: [], attachmentTracks: [], ignoredReason: "excluded_user" };
    }
    if (params.roleIds.some((r) => exclusions.ignoredRoleIds.includes(r))) {
        return { queries: [], attachmentTracks: [], ignoredReason: "excluded_role" };
    }

    const trimmed = params.content.trim();
    const attachmentTracks: Track[] = params.attachments
        .filter(
            (a) =>
                Boolean(
                    a.contentType?.startsWith("audio/") || a.contentType?.startsWith("video/"),
                ) || AUDIO_ATTACHMENT_RE.test(a.name ?? a.url),
        )
        .map((a) => ({
            id: a.id,
            title: a.name ?? "Audio Attachment",
            url: a.url,
            duration: 0,
            thumbnail: "",
            author: "Discord Attachment",
            provider: "attachment",
        }));

    if (trimmed) {
        const allIgnoredPrefixes = [...params.botPrefixes, ...exclusions.ignoredPrefixes].filter(
            Boolean,
        );
        for (const pfx of allIgnoredPrefixes) {
            if (trimmed.startsWith(pfx)) {
                return { queries: [], attachmentTracks: [], ignoredReason: "excluded_prefix" };
            }
        }
    }

    if (!trimmed && attachmentTracks.length === 0) {
        return { queries: [], attachmentTracks: [], ignoredReason: "empty" };
    }

    const lines = trimmed
        ? exclusions.allowMultiLineRequests
            ? trimmed
                  .split(/\r?\n/u)
                  .map((l) => l.trim())
                  .filter(Boolean)
                  .slice(0, 5)
            : [trimmed]
        : [];

    // Guard against obvious conversational paragraphs (> 220 chars and not a URL)
    const filteredQueries = lines.filter((line) => {
        if (/^https?:\/\//iu.test(line)) return true;
        return line.length <= 220;
    });

    if (lines.length > 0 && filteredQueries.length === 0 && attachmentTracks.length === 0) {
        return { queries: [], attachmentTracks: [], ignoredReason: "too_long" };
    }

    return {
        queries: filteredQueries,
        attachmentTracks,
    };
}

export class RequestChannelService {
    private readonly store: DatabaseStore;
    private readonly coordinator: CoordinatorService;
    private readonly providers: ProviderRegistry;
    private readonly sessions: SessionManager;
    private readonly updater = new PlayerMessageUpdater();
    private readonly logger?: Logger;

    public constructor(options: {
        store: DatabaseStore;
        coordinator: CoordinatorService;
        providers: ProviderRegistry;
        sessions: SessionManager;
        logger?: Logger;
    }) {
        this.store = options.store;
        this.coordinator = options.coordinator;
        this.providers = options.providers;
        this.sessions = options.sessions;
        this.logger = options.logger;
    }

    public async handleMessage(params: {
        message: Message;
        runtime: BotRuntimeHandle;
        botPrefixes: readonly string[];
        t: ScopedTranslator;
    }): Promise<boolean> {
        const { message, runtime, t } = params;
        if (!message.guild || message.author.bot) return false;

        const rc = await this.store.getRequestChannel(message.guild.id, runtime.botId);
        if (!rc || rc.channelId !== message.channelId) {
            return false;
        }

        const [guildConfig, botSettings] = await Promise.all([
            this.store.getGuildConfig(message.guild.id),
            this.store.getBotSettings(),
        ]);

        const roleIds = message.member ? Array.from(message.member.roles.cache.keys()) : [];
        const parsed = extractRequestPayloadFromMessage({
            content: message.content,
            isBot: message.author.bot,
            authorId: message.author.id,
            roleIds,
            attachments: Array.from(message.attachments.values()).map((a) => ({
                id: a.id,
                name: a.name,
                url: a.url,
                contentType: a.contentType,
                size: a.size,
            })),
            botPrefixes: params.botPrefixes,
            guildConfig,
        });

        // Clean up user request message when configured (and preserve pinned player message!)
        const shouldDeleteRequest =
            guildConfig.rcExclusions.deleteRequestMessages &&
            message.id !== rc.messageId &&
            message.deletable;

        if (parsed.ignoredReason) {
            if (shouldDeleteRequest && parsed.ignoredReason === "excluded_prefix") {
                void message.delete().catch(() => undefined);
            }
            return true;
        }

        const replyEphemeralFeedback = async (text: string) => {
            if (shouldDeleteRequest) {
                void message.delete().catch(() => undefined);
            }
            const channel = message.channel;
            if (!("send" in channel)) return;
            const sent = await channel
                .send(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: text,
                    }) as never,
                )
                .catch(() => null);
            if (sent) {
                const delay = Math.max(2_000, guildConfig.rcExclusions.deleteFeedbackAfterMs);
                const timer = setTimeout(() => {
                    void sent.delete().catch(() => undefined);
                }, delay);
                timer.unref?.();
            }
        };

        // Enforce sliding-window rate limit per user per guild
        const rl = await this.coordinator.checkRateLimit(
            `rc:${message.guild.id}:${message.author.id}`,
            guildConfig.rcRateLimitMax,
            guildConfig.rcRateLimitWindowMs,
        );
        if (!rl.allowed) {
            await replyEphemeralFeedback(
                t("requestChannel.rateLimited", {
                    seconds: Math.max(1, Math.ceil(rl.retryAfterMs / 1000)),
                }),
            );
            return true;
        }

        const userVcId = message.member?.voice.channelId ?? null;
        if (guildConfig.rcExclusions.requireVoiceChannel && !userVcId) {
            await replyEphemeralFeedback(t("requestChannel.notInVoice"));
            return true;
        }

        const targetVcId =
            userVcId ??
            this.sessions.getSession(message.guild.id, runtime.botId)?.voiceChannelId ??
            null;
        if (!targetVcId) {
            await replyEphemeralFeedback(t("requestChannel.notInVoice"));
            return true;
        }

        const existingSession = this.sessions.getSession(message.guild.id, runtime.botId);
        if (existingSession && existingSession.voiceChannelId !== targetVcId) {
            await replyEphemeralFeedback(t("utils.musicDecorator.sameVC"));
            return true;
        }

        if (shouldDeleteRequest) {
            void message.delete().catch(() => undefined);
        }

        const collectedTracks: Track[] = [...parsed.attachmentTracks];
        const errors: string[] = [];

        for (const q of parsed.queries) {
            try {
                const result = await this.providers.search(
                    q,
                    "youtube",
                    1,
                    botSettings.searchProvider,
                );
                if (result.items.length === 0) {
                    errors.push(q);
                    continue;
                }
                if (result.playlist) {
                    collectedTracks.push(...result.items);
                } else if (result.items[0]) {
                    collectedTracks.push(result.items[0]);
                }
            } catch (err) {
                this.logger?.debug({ err, query: q }, "Request channel query resolution failed");
                errors.push(q);
            }
        }

        if (collectedTracks.length === 0) {
            await replyEphemeralFeedback(t("requestChannel.noResults"));
            return true;
        }

        const session = await this.sessions.getOrCreateSession({
            guildId: message.guild.id,
            botId: runtime.botId,
            voiceChannelId: targetVcId,
            textChannelId: message.channelId,
            createTransport: () =>
                new DiscordVoiceTransport({ client: runtime.client, logger: this.logger }),
        });

        const remainingCapacity = Math.max(0, guildConfig.maxQueueSize - session.queue.size);
        if (remainingCapacity === 0) {
            await replyEphemeralFeedback(
                t("requestChannel.queueLimitReached", { limit: guildConfig.maxQueueSize }),
            );
            return true;
        }

        const toAdd = collectedTracks.slice(0, remainingCapacity);
        const existingKeys = new Set(
            session.queue.getAll().map((q) => `${q.track.provider}:${q.track.id}`),
        );
        const deduped = toAdd.filter((tr, idx, arr) => {
            const k = `${tr.provider}:${tr.id}`;
            if (existingKeys.has(k) && collectedTracks.length === 1) {
                return true; // Allow explicit re-request unless batched duplicate
            }
            return arr.findIndex((other) => `${other.provider}:${other.id}` === k) === idx;
        });

        await session.addAndMaybePlay({
            tracks: deduped,
            requesterId: message.author.id,
            requesterTag: message.author.tag,
        });

        await this.syncPlayerMessage({
            client: runtime.client,
            guildId: message.guild.id,
            botId: runtime.botId,
            botSettings,
            t,
        });

        if (errors.length > 0) {
            await replyEphemeralFeedback(
                t("requestChannel.partialFailure", { failed: errors.join(", ") }),
            );
        }

        return true;
    }

    public async handleMessageDelete(
        guildId: string,
        channelId: string,
        messageId: string,
    ): Promise<void> {
        const list = await this.store.getRequestChannelsForGuild(guildId);
        for (const rc of list) {
            if (rc.channelId === channelId && rc.messageId === messageId) {
                this.updater.invalidate(`${guildId}:${rc.botId}`);
                await this.store.setRequestChannel({
                    ...rc,
                    messageId: null,
                });
            }
        }
    }

    public schedulePlayerSync(params: {
        client: Client;
        guildId: string;
        botId: string;
        botSettings: BotSettings;
        t: ScopedTranslator;
    }): void {
        const key = `${params.guildId}:${params.botId}`;
        this.updater.schedule(key, 800, async () => {
            await this.syncPlayerMessage(params);
        });
    }

    public async syncPlayerMessage(params: {
        client: Client;
        guildId: string;
        botId: string;
        botSettings: BotSettings;
        t: ScopedTranslator;
    }): Promise<void> {
        const rc = await this.store.getRequestChannel(params.guildId, params.botId);
        if (!rc) return;

        const guild =
            params.client.guilds.cache.get(params.guildId) ??
            (await params.client.guilds.fetch(params.guildId).catch(() => null));
        if (!guild) return;

        const channel =
            guild.channels.cache.get(rc.channelId) ??
            (await guild.channels.fetch(rc.channelId).catch(() => null));

        if (
            !channel ||
            (channel.type !== ChannelType.GuildText &&
                channel.type !== ChannelType.GuildVoice &&
                channel.type !== ChannelType.GuildStageVoice)
        ) {
            return;
        }

        const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
        if (me) {
            const perms = channel.permissionsFor(me);
            if (!perms.has(PermissionsBitField.Flags.SendMessages)) return;
        }

        const session = this.sessions.getSession(params.guildId, params.botId);
        const snapshot = session ? session.getSnapshot() : null;
        const upcoming = session ? session.queue.getUpcomingTracks(5) : [];

        const payload = buildPersistentPlayerPayload({
            snapshot,
            botSettings: params.botSettings,
            t: params.t,
            upcoming,
            guildName: guild.name,
        });

        const key = `${params.guildId}:${params.botId}`;
        const textChan = channel as TextBasedChannel & {
            messages?: { fetch: (id: string) => Promise<Message> };
            send?: (opts: unknown) => Promise<Message>;
        };

        if (rc.messageId && textChan.messages) {
            const existingMsg = await textChan.messages.fetch(rc.messageId).catch(() => null);
            if (existingMsg) {
                const ok = await this.updater.editMessageIfChanged(
                    key,
                    existingMsg,
                    payload as never,
                );
                if (ok) return;
            }
        }

        if ("send" in channel && typeof channel.send === "function") {
            const posted = await channel.send(payload as never).catch(() => null);
            if (posted) {
                await this.store.setRequestChannel({
                    ...rc,
                    messageId: posted.id,
                });
            }
        }
    }
}
