import type { ScopedTranslator } from "@rawon/config";
import type { SessionStateSnapshot } from "@rawon/music-core";
import {
    type BotSettings,
    chunkText,
    createProgressBar,
    formatDurationMs,
    type LyricsResult,
    type QueuedTrack,
    safeThumbUrl,
} from "@rawon/shared";
import {
    ActionRowBuilder,
    type BaseMessageOptions,
    ButtonBuilder,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    type Message,
    MessageFlags,
    SectionBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    StringSelectMenuBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";

export function parseAccentColor(hex: string): number {
    const cleaned = hex.replace(/^#/u, "");
    const parsed = Number.parseInt(cleaned, 16);
    return Number.isFinite(parsed) ? parsed : 0xdf3b57;
}

export function buildNoticeContainer(params: {
    colorHex: string;
    title?: string;
    description: string;
}): { components: ContainerBuilder[]; flags: number } {
    const container = new ContainerBuilder().setAccentColor(parseAccentColor(params.colorHex));
    if (params.title) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`### ${params.title}\n${params.description}`),
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(params.description));
    }
    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2,
    };
}

export function buildPersistentPlayerPayload(params: {
    snapshot: SessionStateSnapshot | null;
    botSettings: BotSettings;
    t: ScopedTranslator;
    upcoming?: QueuedTrack[];
    guildName?: string;
    bannerImageUrl?: string | null;
}): { components: ContainerBuilder[]; flags: number } {
    const { snapshot, botSettings, t, upcoming = [] } = params;
    const container = new ContainerBuilder().setAccentColor(
        parseAccentColor(botSettings.embedColor),
    );

    const current = snapshot?.currentTrack ?? null;
    const playerState = snapshot?.playerState;

    if (!current || !snapshot || snapshot.status === "stopped" || snapshot.status === "idle") {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `## ${t("requestChannel.title")}\n${t("requestChannel.standby")}`,
            ),
        );

        const splashUrl = safeThumbUrl(params.bannerImageUrl ?? botSettings.requestChannelSplash);
        if (splashUrl) {
            container.addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(splashUrl)),
            );
        }
    } else {
        const track = current.track;
        const durationMs = track.duration * 1000;
        const statusBadge =
            snapshot.status === "paused"
                ? `⏸ ${t("requestChannel.pausedBadge")}`
                : snapshot.status === "recovering"
                  ? `🔄 ${t("requestChannel.recoveringBadge")}`
                  : snapshot.status === "buffering"
                    ? `⏳ ${t("requestChannel.bufferingBadge")}`
                    : `▶ ${t("requestChannel.nowPlayingBadge")}`;

        const progressText = track.isLive
            ? `🔴 ${t("requestChannel.live")}`
            : `${formatDurationMs(snapshot.positionMs)} ${createProgressBar(snapshot.positionMs, durationMs, 14)} ${formatDurationMs(durationMs)}`;

        const headerLines = [
            `**${statusBadge}**`,
            `### [${track.title}](${track.url})`,
            track.author ? `*${track.author}*` : null,
            `\`${progressText}\``,
            `${t("requestChannel.requestedBy")}: <@${current.requesterId}>`,
        ]
            .filter(Boolean)
            .join("\n");

        const thumb = safeThumbUrl(track.thumbnail);
        if (thumb) {
            const section = new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb));
            container.addSectionComponents(section);
        } else {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines));
        }
    }

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    const vol = playerState?.volume ?? botSettings.defaultVolume;
    const loop = playerState?.loopMode ?? "OFF";
    const shuffleLabel = playerState?.shuffle ? t("reusable.enabled") : t("reusable.disabled");
    const autoplayLabel = playerState?.autoplay ? t("reusable.enabled") : t("reusable.disabled");
    const queueCount = snapshot?.queueLength ?? 0;

    const statusLine = [
        `🔊 **${vol}%**`,
        `🔁 **${loop}**`,
        `🔀 **${shuffleLabel}**`,
        `📻 **${autoplayLabel}**`,
        `📜 **${queueCount}**`,
        snapshot?.pipelineMode ? `⚡ \`${snapshot.pipelineMode}\`` : null,
    ]
        .filter(Boolean)
        .join("  •  ");

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(statusLine));

    if (upcoming.length > 0) {
        const upLines = upcoming.slice(0, 5).map((item, idx) => {
            const dur = item.track.isLive
                ? t("requestChannel.live")
                : formatDurationMs(item.track.duration * 1000);
            return `\`${idx + 1}.\` **${item.track.title}** (\`${dur}\`)`;
        });
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `**${t("requestChannel.upNext")}**\n${upLines.join("\n")}`,
            ),
        );
    }

    container.addSeparatorComponents(
        new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small),
    );

    const hasTrack = Boolean(current && snapshot && snapshot.status !== "stopped");
    const isPaused = snapshot?.paused ?? false;

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("rc_prev")
            .setEmoji("⏮️")
            .setLabel(t("requestChannel.previousButton"))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasTrack),
        new ButtonBuilder()
            .setCustomId("rc_pause")
            .setEmoji(isPaused ? "▶️" : "⏸️")
            .setLabel(isPaused ? t("requestChannel.resumeButton") : t("requestChannel.pauseButton"))
            .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary)
            .setDisabled(!hasTrack),
        new ButtonBuilder()
            .setCustomId("rc_skip")
            .setEmoji("⏭️")
            .setLabel(t("requestChannel.skipButton"))
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!hasTrack),
        new ButtonBuilder()
            .setCustomId("rc_stop")
            .setEmoji("⏹️")
            .setLabel(t("requestChannel.stopButton"))
            .setStyle(ButtonStyle.Danger)
            .setDisabled(!hasTrack),
        new ButtonBuilder()
            .setCustomId("rc_queue")
            .setEmoji("📜")
            .setLabel(t("requestChannel.queueButton"))
            .setStyle(ButtonStyle.Secondary),
    );

    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId("rc_shuffle")
            .setEmoji("🔀")
            .setLabel(t("requestChannel.shuffleButton"))
            .setStyle(playerState?.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("rc_repeat")
            .setEmoji(loop === "SONG" ? "🔂" : "🔁")
            .setLabel(`${t("requestChannel.loopButton")}: ${loop}`)
            .setStyle(loop !== "OFF" ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("rc_volume")
            .setEmoji("🔊")
            .setLabel(`${t("requestChannel.volumeModalButton")}: ${vol}%`)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId("rc_autoplay")
            .setEmoji("📻")
            .setLabel(t("requestChannel.autoplayButton"))
            .setStyle(playerState?.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary),
    );

    container.addActionRowComponents(row1).addActionRowComponents(row2);

    return {
        components: [container],
        flags: MessageFlags.IsComponentsV2,
    };
}

export function buildQueuePagePayload(params: {
    tracks: QueuedTrack[];
    currentKey: string | null;
    page: number;
    pageSize?: number;
    botSettings: BotSettings;
    t: ScopedTranslator;
    guildId: string;
    botId: string;
}): { components: ContainerBuilder[]; flags: number } {
    const pageSize = params.pageSize ?? 10;
    const totalPages = Math.max(1, Math.ceil(params.tracks.length / pageSize));
    const currentPage = Math.max(1, Math.min(params.page, totalPages));
    const slice = params.tracks.slice((currentPage - 1) * pageSize, currentPage * pageSize);

    const container = new ContainerBuilder().setAccentColor(
        parseAccentColor(params.botSettings.embedColor),
    );

    if (params.tracks.length === 0) {
        container.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(params.t("requestChannel.emptyQueue")),
        );
        return { components: [container], flags: MessageFlags.IsComponentsV2 };
    }

    const lines = slice.map((item, idx) => {
        const num = (currentPage - 1) * pageSize + idx + 1;
        const marker = item.key === params.currentKey ? "▶ " : "";
        const dur = item.track.isLive
            ? params.t("requestChannel.live")
            : formatDurationMs(item.track.duration * 1000);
        return `${marker}\`${num}.\` **[${item.track.title}](${item.track.url})** • \`${dur}\` • <@${item.requesterId}>`;
    });

    container
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(
                `### ${params.t("requestChannel.queueListTitle")} (${params.tracks.length})\n${lines.join("\n")}\n\n${params.t("reusable.pageFooter", { actual: currentPage, total: totalPages })}`,
            ),
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`queue_page:${params.botId}:${currentPage - 1}`)
                    .setEmoji("◀️")
                    .setLabel(params.t("common.previous"))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage <= 1),
                new ButtonBuilder()
                    .setCustomId(`queue_page:${params.botId}:${currentPage + 1}`)
                    .setEmoji("▶️")
                    .setLabel(params.t("common.next"))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage >= totalPages),
            ),
        );

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export function buildLyricsPagePayload(params: {
    lyrics: LyricsResult;
    page: number;
    botSettings: BotSettings;
    t: ScopedTranslator;
    ownerId: string;
}): { components: ContainerBuilder[]; flags: number } {
    const pages = chunkText(params.lyrics.lyrics, 3200);
    const totalPages = Math.max(1, pages.length);
    const currentPage = Math.max(1, Math.min(params.page, totalPages));
    const body = pages[currentPage - 1] ?? params.lyrics.lyrics;

    const container = new ContainerBuilder().setAccentColor(
        parseAccentColor(params.botSettings.embedColor),
    );

    const header = `### ${params.lyrics.song ?? "Lyrics"}${params.lyrics.artist ? ` — ${params.lyrics.artist}` : ""}\n${body}\n\n*Source: ${params.lyrics.source} • Page ${currentPage}/${totalPages}*`;
    const thumb = safeThumbUrl(params.lyrics.albumArt);
    if (thumb) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(header))
                .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumb)),
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(header));
    }

    if (totalPages > 1) {
        container.addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`lyrics_page:${params.ownerId}:${currentPage - 1}`)
                    .setLabel(params.t("common.previous"))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage <= 1),
                new ButtonBuilder()
                    .setCustomId(`lyrics_page:${params.ownerId}:${currentPage + 1}`)
                    .setLabel(params.t("common.next"))
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(currentPage >= totalPages),
            ),
        );
    }

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

export function buildFilterSelectPayload(params: {
    activeFilters: Record<string, boolean | undefined>;
    botSettings: BotSettings;
    t: ScopedTranslator;
    botId: string;
}): { components: ContainerBuilder[]; flags: number } {
    const container = new ContainerBuilder().setAccentColor(
        parseAccentColor(params.botSettings.embedColor),
    );

    const activeList = Object.entries(params.activeFilters)
        .filter(([, v]) => Boolean(v))
        .map(([k]) => `\`${k}\``);

    container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
            `### ${params.t("requestChannel.filtersTitle")}\n${activeList.length > 0 ? activeList.join(", ") : params.t("requestChannel.noFiltersActive")}`,
        ),
    );

    const filterOptions = [
        "bassboost",
        "nightcore",
        "vaporwave",
        "treble",
        "8d",
        "reverse",
        "surround",
        "haas",
        "phaser",
        "gate",
        "mcompand",
        "flanger",
        "tremolo",
        "karaoke",
        "vibrato",
        "echo",
        "spedup",
        "slowed",
        "reverb",
    ].map((name) => ({
        label: `${name}${params.activeFilters[name] ? " (ON)" : ""}`,
        value: name,
    }));

    container
        .addActionRowComponents(
            new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`filter_toggle:${params.botId}`)
                    .setPlaceholder(params.t("requestChannel.selectFiltersPlaceholder"))
                    .setMinValues(1)
                    .setMaxValues(1)
                    .addOptions(filterOptions),
            ),
        )
        .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`filter_reset:${params.botId}`)
                    .setLabel(params.t("requestChannel.resetFiltersButton"))
                    .setStyle(ButtonStyle.Danger),
            ),
        );

    return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

/**
 * Debounced per-guild player message updater with signature deduplication.
 * Prevents Discord REST rate-limit churn and cleans up gracefully on 10008 Unknown Message.
 */
export class PlayerMessageUpdater {
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly timerDeadlines = new Map<string, number>();
    private readonly lastHash = new Map<string, string>();
    private readonly pendingFns = new Map<string, () => Promise<void>>();
    private readonly inFlight = new Map<string, Promise<void>>();

    public schedule(key: string, delayMs: number, fn: () => Promise<void>): void {
        this.pendingFns.set(key, fn);
        const now = Date.now();
        const targetDeadline = now + Math.max(0, delayMs);
        const existingTimer = this.timers.get(key);
        const existingDeadline = this.timerDeadlines.get(key);

        if (existingTimer && existingDeadline !== undefined) {
            if (existingDeadline <= targetDeadline + 15) {
                return;
            }
            clearTimeout(existingTimer);
            this.timers.delete(key);
            this.timerDeadlines.delete(key);
        }

        const timer = setTimeout(
            () => {
                this.timers.delete(key);
                this.timerDeadlines.delete(key);
                this.drainPending(key);
            },
            Math.max(0, delayMs),
        );
        timer.unref?.();
        this.timers.set(key, timer);
        this.timerDeadlines.set(key, targetDeadline);
    }

    public async runExclusive(key: string, fn: () => Promise<void>): Promise<void> {
        const existingTimer = this.timers.get(key);
        if (existingTimer) {
            clearTimeout(existingTimer);
            this.timers.delete(key);
            this.timerDeadlines.delete(key);
        }
        this.pendingFns.set(key, fn);
        await this.drainPending(key);
    }

    private drainPending(key: string): Promise<void> {
        const active = this.inFlight.get(key);
        if (active) {
            return active;
        }
        const loop = (async () => {
            while (this.pendingFns.has(key)) {
                const nextFn = this.pendingFns.get(key);
                this.pendingFns.delete(key);
                if (nextFn) {
                    await nextFn().catch(() => undefined);
                }
            }
        })().finally(() => {
            this.inFlight.delete(key);
            if (this.pendingFns.has(key) && !this.timers.has(key)) {
                void this.drainPending(key);
            }
        });
        this.inFlight.set(key, loop);
        return loop;
    }

    public async editMessageIfChanged(
        key: string,
        message: Message,
        payload: BaseMessageOptions,
    ): Promise<boolean> {
        const serialized = JSON.stringify(payload.components ?? []);
        if (this.lastHash.get(key) === serialized) {
            return true;
        }
        try {
            await message.edit({
                ...payload,
                content: null,
                embeds: [],
            });
            this.lastHash.set(key, serialized);
            return true;
        } catch (err) {
            const code = (err as { code?: number })?.code;
            if (code === 10008 || code === 50001 || code === 10003) {
                this.lastHash.delete(key);
                return false;
            }
            return true;
        }
    }

    public invalidate(key: string): void {
        this.lastHash.delete(key);
        const t = this.timers.get(key);
        if (t) {
            clearTimeout(t);
            this.timers.delete(key);
        }
        this.timerDeadlines.delete(key);
        this.pendingFns.delete(key);
    }
}
