import type { PreparedAudioStream } from "@rawon/audio-engine";

export type PlaybackFinishReason = "ended" | "stopped" | "error";

export interface VoiceMemberInfo {
    userId: string;
    isBot: boolean;
    deafened: boolean;
}

export interface VoiceConnectionHealth {
    connected: boolean;
    pingMs: number;
    channelId: string | null;
}

export interface VoiceTransport {
    connect(guildId: string, channelId: string): Promise<void>;
    disconnect(guildId: string): Promise<void>;
    moveChannel?(guildId: string, newChannelId: string): Promise<void>;
    playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, error?: Error) => void,
    ): Promise<void>;
    pause(): Promise<boolean>;
    resume(): Promise<boolean>;
    stop(): Promise<void>;
    setInlineVolume?(volumePercent: number): boolean;
    ensureStageSpeaker?(guildId: string, channelId: string): Promise<void>;
    setVoiceChannelStatus?(
        guildId: string,
        channelId: string,
        status: string | null,
    ): Promise<void>;
    getVoiceChannelMembers?(guildId: string, channelId: string): Promise<VoiceMemberInfo[]>;
    getHealth?(guildId: string): VoiceConnectionHealth;
}

export class NullVoiceTransport implements VoiceTransport {
    private channelId: string | null = null;
    private currentPrepared: PreparedAudioStream | null = null;

    public async connect(_guildId: string, channelId: string): Promise<void> {
        this.channelId = channelId;
    }

    public async disconnect(_guildId: string): Promise<void> {
        await this.stop();
        this.channelId = null;
    }

    public async playStream(
        prepared: PreparedAudioStream,
        onFinished: (reason: PlaybackFinishReason, error?: Error) => void,
    ): Promise<void> {
        await this.stop();
        this.currentPrepared = prepared;

        let settled = false;
        const finish = (reason: PlaybackFinishReason, err?: Error) => {
            if (settled) return;
            settled = true;
            void prepared.cleanup().finally(() => onFinished(reason, err));
        };

        prepared.stream.on("data", () => {
            // Drain stream for headless tests/benchmarks
        });
        prepared.stream.once("end", () => finish("ended"));
        prepared.stream.once("close", () => finish("ended"));
        prepared.stream.once("error", (err) => finish("error", err));
    }

    public async pause(): Promise<boolean> {
        if (!this.currentPrepared) return false;
        this.currentPrepared.stream.pause();
        return true;
    }

    public async resume(): Promise<boolean> {
        if (!this.currentPrepared) return false;
        this.currentPrepared.stream.resume();
        return true;
    }

    public async stop(): Promise<void> {
        if (this.currentPrepared) {
            const p = this.currentPrepared;
            this.currentPrepared = null;
            await p.cleanup();
        }
    }

    public getHealth(_guildId: string): VoiceConnectionHealth {
        return {
            connected: this.channelId !== null,
            pingMs: 0,
            channelId: this.channelId,
        };
    }
}
