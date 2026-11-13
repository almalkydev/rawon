import type { AudioPipeline } from "@rawon/audio-engine";
import type { DiskAudioCache, PrefetchCoordinator } from "@rawon/cache";
import type { I18nService, RawonConfig, ScopedTranslator } from "@rawon/config";
import type { CoordinatorService, DatabaseStore } from "@rawon/database";
import type { GuildMusicSession, SessionManager } from "@rawon/music-core";
import type { ProviderRegistry } from "@rawon/providers";
import type { Logger } from "@rawon/shared";
import type {
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    Client,
    Guild,
    GuildMember,
    Message,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    SlashCommandBuilder,
    SlashCommandOptionsOnlyBuilder,
    SlashCommandSubcommandsOnlyBuilder,
    TextBasedChannel,
} from "discord.js";

export type CommandCategory = "developers" | "general" | "music";

export interface CommandGuards {
    guildOnly?: boolean;
    devOnly?: boolean;
    djOnly?: boolean;
    inVoiceChannel?: boolean;
    sameVoiceChannel?: boolean;
    requireActiveSession?: boolean;
    requireCurrentTrack?: boolean;
    requireAdmin?: boolean;
}

export interface CommandArgsReader {
    getString(name: string, positionalIndex?: number, joinRest?: boolean): string | null;
    getInteger(name: string, positionalIndex?: number): number | null;
    getBoolean(name: string, positionalIndex?: number): boolean | null;
    getUserId(name: string, positionalIndex?: number): string | null;
    getRoleId(name: string, positionalIndex?: number): string | null;
    getChannelId(name: string, positionalIndex?: number): string | null;
    getAttachmentUrl(name: string): string | null;
    getSubcommand(positionalIndex?: number): string | null;
    rawArgs: string[];
}

export interface BotServices {
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
    getBotRuntimes: () => BotRuntimeHandle[];
    getActiveBotCount: () => number;
    getOrCreateGoogleLoginService: () => import("./GoogleLoginService.js").GoogleLoginService;
    getCookieStore: () => import("./CookieStore.js").CookieStore;
    syncRequestChannelPlayer: (guildId: string, botId: string) => Promise<void>;
    registerSlashCommandsForBot: (botId: string) => Promise<number>;
}

export interface BotRuntimeHandle {
    botId: string;
    tokenIndex: number;
    client: Client;
    tag: string;
    getUptimeMs: () => number;
    pickBestBotForGuild: (
        guildId: string,
        userVoiceChannelId?: string | null,
    ) => Promise<BotRuntimeHandle>;
}

export interface CommandContext {
    source: "slash" | "prefix" | "context_menu";
    client: Client;
    runtime: BotRuntimeHandle;
    services: BotServices;
    guild: Guild | null;
    member: GuildMember | null;
    channel: TextBasedChannel | null;
    userId: string;
    userTag: string;
    locale: string;
    t: ScopedTranslator;
    prefix: string;
    args: CommandArgsReader;
    interaction?: ChatInputCommandInteraction;
    message?: Message;
    activeSession?: GuildMusicSession;
    reply: (
        payload: string | Record<string, unknown>,
        ephemeral?: boolean,
    ) => Promise<Message | null>;
    editReply: (payload: string | Record<string, unknown>) => Promise<void>;
    defer: (ephemeral?: boolean) => Promise<void>;
}

export type SlashBuilderLike =
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder
    | Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;

export interface CommandDefinition {
    name: string;
    aliases?: readonly string[];
    category: CommandCategory;
    descriptionKey: string;
    usage?: string;
    cooldownMs?: number;
    guards?: CommandGuards;
    buildSlash: (
        i18n: I18nService,
    ) => SlashBuilderLike | RESTPostAPIChatInputApplicationCommandsJSONBody;
    execute: (ctx: CommandContext) => Promise<void>;
    autocomplete?: (interaction: AutocompleteInteraction, services: BotServices) => Promise<void>;
}
