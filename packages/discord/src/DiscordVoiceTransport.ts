import {
    type AudioPlayer,
    AudioPlayerStatus,
    createAudioPlayer,
    createAudioResource,
    entersState,
    joinVoiceChannel,
    NoSubscriberBehavior,
    StreamType,
    type VoiceConnection,
    VoiceConnectionStatus,
} from "@discordjs/voice";
import type { PreparedAudioStream } from "@rawon/audio-engine";
import type {
    PlaybackFinishReason,
    VoiceConnectionHealth,
    VoiceMemberInfo,
    VoiceTransport,
} from "@rawon/music-core";
import type { Logger } from "@rawon/shared";
import { ChannelType, type Client, type VoiceBasedChannel } from "discord.js";

export class DiscordVoiceTransport implements VoiceTransport {
    private readonly client: Client;
    private readonly logger?: Logger;
    private readonly player: AudioPlayer;
    private connection: VoiceConnection | null = null;
    private currentPrepared: PreparedAudioStream | null = null;
    private currentChannelId: string | null = null;
    private activeFinishCallback: ((reason: PlaybackFinishReason, err?: Error) => void) | null =
        null;
    private activePlaybackToken = 0;

    public constructor(options: { client: Client; logger?: Logger }) {
        this.client = options.client;
        this.logger = options.logger;
        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
                maxMissedFrames: 250,
            },
        });

        this.player.on("error", (err) => {
            const cb = this.activeFinishCallback;
            this.activeFinishCallback = null;
            void this.cleanupPrepared().finally(() => {
                cb?.("error", err instanceof Error ? err : new Error(String(err)));
            });
        });

        this.player.on(AudioPlayerStatus.Idle, () => {
            const cb = this.activeFinishCallback;
            if (!cb) return;
            this.activeFinishCallback = null;
            void this.cleanupPrepared().finally(() => {
                cb("ended");
            });
        });
    }

    public async connect(guildId: string, channelId: string): Promise<void> {
        const guild = await this.client.guilds.fetch(guildId);
        if (
            this.connection &&
            this.connection.state.status !== VoiceConnectionStatus.Destroyed &&
            this.currentChannelId === channelId
        ) {
            if (this.connection.state.status !== VoiceConnectionStatus.Ready) {
                await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
            }
            return;
        }

        if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
            this.connection = null;
        }

        const connection = joinVoiceChannel({
            channelId,
            guildId,
            group: this.client.user?.id ?? "default",
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: false,
        });

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
            } catch {
                if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }
            }
        });

        connection.on("error", (err) => {
            this.logger?.warn({ err, guildId, channelId }, "Voice connection error");
        });

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (this.connection === connection) {
                this.connection = null;
                this.currentChannelId = null;
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        connection.subscribe(this.player);
        this.connection = connection;
        this.currentChannelId = channelId;
    }

    public async moveChannel(guildId: string, newChannelId: string): Promise<void> {
        await this.connect(guildId, newChannelId);
    }

    public async disconnect(_guildId: string): Promise<void> {
        await this.stop();
        if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection.destroy();
        }
        this.connection = null;
        this.currentChannelId = null;
    }

    public async playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, error?: Error) => void,
    ): Promise<void> {
        const token = ++this.activePlaybackToken;
        this.activeFinishCallback = null;

        let earlyStreamError: Error | null = null;
        const onEarlyStreamError = (err: Error) => {
            earlyStreamError = err;
        };
        prepared.stream.on("error", onEarlyStreamError);

        await this.cleanupPrepared();

        if (token !== this.activePlaybackToken) {
            prepared.stream.off("error", onEarlyStreamError);
            await prepared.cleanup().catch(() => undefined);
            return;
        }
        if (earlyStreamError) {
            prepared.stream.off("error", onEarlyStreamError);
            await prepared.cleanup().catch(() => undefined);
            onFinished("error", earlyStreamError);
            return;
        }

        this.currentPrepared = prepared;
        const inputType =
            prepared.outputEncoding === "opus-packets" ? StreamType.Opus : StreamType.Raw;

        const resource = createAudioResource(prepared.stream, {
            inputType,
            inlineVolume: inputType === StreamType.Raw && !prepared.volumeTransform,
            silencePaddingFrames: 5,
        });
        prepared.stream.off("error", onEarlyStreamError);

        this.activeFinishCallback = (reason, err) => {
            if (token !== this.activePlaybackToken) return;
            onFinished(reason, err);
        };

        this.player.play(resource);
        await entersState(this.player, AudioPlayerStatus.Playing, 15_000).catch((err) => {
            this.logger?.debug({ err }, "AudioPlayer did not enter Playing state within 15s");
        });
    }

    public async pause(): Promise<boolean> {
        return this.player.pause(true);
    }

    public async resume(): Promise<boolean> {
        return this.player.unpause();
    }

    public async stop(): Promise<void> {
        this.activePlaybackToken += 1;
        this.activeFinishCallback = null;
        this.player.stop(true);
        await this.cleanupPrepared();
    }

    public setInlineVolume(volumePercent: number): boolean {
        const current = this.currentPrepared;
        if (current?.volumeTransform) {
            current.volumeTransform.setVolumePercent(volumePercent);
            return true;
        }
        if (
            this.player.state.status !== AudioPlayerStatus.Idle &&
            "resource" in this.player.state &&
            this.player.state.resource.volume
        ) {
            const clamped = Math.max(0, Math.min(200, volumePercent));
            this.player.state.resource.volume.setVolume(clamped / 100);
            return true;
        }
        return false;
    }

    public async ensureStageSpeaker(guildId: string, channelId: string): Promise<void> {
        try {
            const guild =
                this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
            const channel =
                guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId));
            if (!channel || channel.type !== ChannelType.GuildStageVoice) return;

            const me = guild.members.me ?? (await guild.members.fetchMe());
            if (!me.voice.suppress) return;

            await me.voice.setSuppressed(false).catch(async () => {
                await me.voice.setRequestToSpeak(true).catch(() => undefined);
            });
        } catch (err) {
            this.logger?.debug({ err, guildId, channelId }, "Stage speaker promotion failed");
        }
    }

    public async setVoiceChannelStatus(
        _guildId: string,
        channelId: string,
        status: string | null,
    ): Promise<void> {
        try {
            await this.client.rest.put(`/channels/${channelId}/voice-status`, {
                body: { status: status ?? "" },
            });
        } catch {
            // Ignored intentionally: bots may lack SetVoiceChannelStatus permission in some servers
        }
    }

    public async getVoiceChannelMembers(
        guildId: string,
        channelId: string,
    ): Promise<VoiceMemberInfo[]> {
        try {
            const guild =
                this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId));
            const channel = guild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
            if (!channel || !("members" in channel)) return [];
            return Array.from(channel.members.values()).map((member) => ({
                userId: member.id,
                isBot: member.user.bot,
                deafened: Boolean(member.voice.deaf || member.voice.selfDeaf),
            }));
        } catch {
            return [];
        }
    }

    public getHealth(_guildId: string): VoiceConnectionHealth {
        return {
            connected:
                this.connection !== null &&
                this.connection.state.status === VoiceConnectionStatus.Ready,
            pingMs: this.connection?.ping.udp ?? -1,
            channelId: this.currentChannelId,
        };
    }

    private async cleanupPrepared(): Promise<void> {
        if (this.currentPrepared) {
            const p = this.currentPrepared;
            this.currentPrepared = null;
            await p.cleanup().catch(() => undefined);
        }
    }
}
