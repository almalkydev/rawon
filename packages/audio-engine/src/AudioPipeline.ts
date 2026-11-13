import { createReadStream } from "node:fs";
import type { Readable } from "node:stream";
import {
    AudioEngineError,
    type AudioFiltersState,
    type AudioQualityProfile,
    type EqualizerBand,
    ExpiredStreamError,
    type Logger,
    type StreamDescriptor,
} from "@rawon/shared";
import prism from "prism-media";
import { inspectHeaderBytes, type ProbeResult, peekStreamAndProbe } from "./codecProbe.js";
import { buildFfmpegArgs, hasAnyActiveDsp } from "./filterBuilder.js";
import { ProcessSupervisor, resolveFfmpegExecutable } from "./ProcessSupervisor.js";
import { SmoothVolumeTransform } from "./SmoothVolumeTransform.js";

export type PipelineMode =
    | "passthrough-webm-opus"
    | "passthrough-ogg-opus"
    | "ffmpeg-ogg-opus"
    | "ffmpeg-pcm-inline";

export type AudioOutputEncoding = "opus-packets" | "s16le-pcm";

export interface PlaybackPipelineRequest {
    descriptor: StreamDescriptor;
    sourceStream?: Readable;
    seekSeconds?: number;
    volumePercent?: number;
    filters?: AudioFiltersState;
    equalizer?: readonly EqualizerBand[];
    normalizeAudio?: boolean;
    qualityProfile?: AudioQualityProfile;
    enableRealtimeVolumeTransform?: boolean;
    signal?: AbortSignal;
}

export interface PreparedAudioStream {
    mode: PipelineMode;
    outputEncoding: AudioOutputEncoding;
    stream: Readable;
    probe: ProbeResult;
    processId?: string;
    volumeTransform?: SmoothVolumeTransform;
    cleanup: () => Promise<void>;
}

export function canUseOpusPassthrough(params: {
    probe: ProbeResult;
    seekSeconds: number;
    volumePercent: number;
    filters?: AudioFiltersState;
    equalizer?: readonly EqualizerBand[];
    normalizeAudio?: boolean;
    enableRealtimeVolumeTransform?: boolean;
}): boolean {
    if (params.seekSeconds > 0) return false;
    if (params.enableRealtimeVolumeTransform) return false;
    if (Math.abs(params.volumePercent - 100) > 0.1) return false;
    if (
        hasAnyActiveDsp({
            filters: params.filters,
            equalizer: params.equalizer ? [...params.equalizer] : [],
            normalizeAudio: params.normalizeAudio ?? false,
        })
    ) {
        return false;
    }
    return (
        params.probe.opusPassthroughCompatible &&
        (params.probe.container === "webm" || params.probe.container === "ogg")
    );
}

export class AudioPipeline {
    public readonly supervisor: ProcessSupervisor;
    private readonly ffmpegPath: string;
    private readonly logger?: Logger;

    public constructor(
        options: {
            supervisor?: ProcessSupervisor;
            ffmpegPath?: string | null;
            logger?: Logger;
        } = {},
    ) {
        this.supervisor = options.supervisor ?? new ProcessSupervisor({ logger: options.logger });
        this.ffmpegPath = resolveFfmpegExecutable(options.ffmpegPath);
        this.logger = options.logger;
    }

    public getFfmpegExecutable(): string {
        return this.ffmpegPath;
    }

    public async preparePlaybackStream(
        request: PlaybackPipelineRequest,
    ): Promise<PreparedAudioStream> {
        const seekSeconds = Math.max(0, request.seekSeconds ?? 0);
        const volumePercent = Math.max(0, Math.min(200, request.volumePercent ?? 100));
        const qualityProfile = request.qualityProfile ?? "fidelity";
        const useInlinePcm = request.enableRealtimeVolumeTransform === true;
        const descriptor = request.descriptor;

        // 1. If we have a local cached file or an open Readable stream, inspect header & attempt passthrough when eligible
        if (request.sourceStream || descriptor.cacheFilePath) {
            const rawStream =
                request.sourceStream ??
                createReadStream(descriptor.cacheFilePath as string, { highWaterMark: 64 * 1024 });

            const { probe, stream: peekedStream } = await peekStreamAndProbe(rawStream, descriptor);

            if (
                canUseOpusPassthrough({
                    probe,
                    seekSeconds,
                    volumePercent,
                    filters: request.filters,
                    equalizer: request.equalizer,
                    normalizeAudio: request.normalizeAudio,
                    enableRealtimeVolumeTransform: useInlinePcm,
                })
            ) {
                const mode: PipelineMode =
                    probe.container === "webm" ? "passthrough-webm-opus" : "passthrough-ogg-opus";
                const demuxer =
                    probe.container === "webm"
                        ? new prism.opus.WebmDemuxer()
                        : new prism.opus.OggDemuxer();

                peekedStream.on("error", (err) => {
                    if (!demuxer.destroyed) demuxer.destroy(err);
                });
                peekedStream.pipe(demuxer);

                const cleanup = async () => {
                    if (!demuxer.destroyed) demuxer.destroy();
                    if (!peekedStream.destroyed) peekedStream.destroy();
                    if (!rawStream.destroyed) rawStream.destroy();
                };

                if (request.signal) {
                    request.signal.addEventListener(
                        "abort",
                        () => {
                            void cleanup();
                        },
                        { once: true },
                    );
                }

                return {
                    mode,
                    outputEncoding: "opus-packets",
                    stream: demuxer,
                    probe,
                    cleanup,
                };
            }

            // Can read local cached file directly with FFmpeg using fast input -ss seek!
            if (descriptor.cacheFilePath && !request.sourceStream) {
                peekedStream.destroy();
                rawStream.destroy();
                return this.spawnFfmpegPipeline({
                    inputSource: descriptor.cacheFilePath,
                    isHttpInput: false,
                    seekSeconds,
                    volumePercent,
                    qualityProfile,
                    filters: request.filters,
                    equalizer: request.equalizer,
                    normalizeAudio: request.normalizeAudio,
                    useInlinePcm,
                    probe,
                    signal: request.signal,
                });
            }

            // Pipe in-memory stream into FFmpeg stdin cleanly
            return this.spawnFfmpegPipeline({
                inputSource: "pipe:0",
                pipeStream: peekedStream,
                isHttpInput: false,
                seekSeconds: 0, // pipe:0 cannot seek backward; handled when caching or URL input is used
                volumePercent,
                qualityProfile,
                filters: request.filters,
                equalizer: request.equalizer,
                normalizeAudio: request.normalizeAudio,
                useInlinePcm,
                probe,
                signal: request.signal,
            });
        }

        // 2. Direct / Remote HTTP stream
        const isHttp = /^https?:\/\//iu.test(descriptor.url);
        const hintProbe = inspectHeaderBytes(Buffer.alloc(0), descriptor);

        // Try HTTP passthrough directly when source metadata confirms stereo 48k Opus in WebM/Ogg
        if (
            isHttp &&
            canUseOpusPassthrough({
                probe: {
                    container:
                        descriptor.container === "webm"
                            ? "webm"
                            : descriptor.container === "ogg" || descriptor.container === "opus"
                              ? "ogg"
                              : "unknown",
                    codec: descriptor.codec ?? "",
                    sampleRate: descriptor.sampleRate ?? 48_000,
                    channels: descriptor.channels ?? 2,
                    opusPassthroughCompatible: descriptor.directPassthroughEligible,
                },
                seekSeconds,
                volumePercent,
                filters: request.filters,
                equalizer: request.equalizer,
                normalizeAudio: request.normalizeAudio,
                enableRealtimeVolumeTransform: useInlinePcm,
            })
        ) {
            const fetchController = new AbortController();
            const combinedSignal = request.signal
                ? AbortSignal.any([request.signal, fetchController.signal])
                : fetchController.signal;

            const response = await fetch(descriptor.url, {
                method: "GET",
                headers: descriptor.headers,
                signal: combinedSignal,
            });

            if (
                response.status === 401 ||
                response.status === 403 ||
                response.status === 404 ||
                response.status === 410
            ) {
                throw new ExpiredStreamError(
                    `Remote audio stream expired or denied (HTTP ${response.status})`,
                    response.status,
                );
            }
            if (!response.ok || !response.body) {
                throw new AudioEngineError(
                    `HTTP stream returned status ${response.status}`,
                    response.status >= 500,
                );
            }

            const { Readable: NodeReadable } = await import("node:stream");
            const nodeStream = NodeReadable.fromWeb(
                response.body as import("node:stream/web").ReadableStream<Uint8Array>,
            );

            const { probe, stream: verifiedStream } = await peekStreamAndProbe(
                nodeStream,
                descriptor,
            );
            if (
                canUseOpusPassthrough({
                    probe,
                    seekSeconds,
                    volumePercent,
                    filters: request.filters,
                    equalizer: request.equalizer,
                    normalizeAudio: request.normalizeAudio,
                    enableRealtimeVolumeTransform: useInlinePcm,
                })
            ) {
                const mode: PipelineMode =
                    probe.container === "webm" ? "passthrough-webm-opus" : "passthrough-ogg-opus";
                const demuxer =
                    probe.container === "webm"
                        ? new prism.opus.WebmDemuxer()
                        : new prism.opus.OggDemuxer();

                verifiedStream.on("error", (err) => {
                    if (!demuxer.destroyed) demuxer.destroy(err);
                });
                verifiedStream.pipe(demuxer);

                const cleanup = async () => {
                    fetchController.abort();
                    if (!demuxer.destroyed) demuxer.destroy();
                    if (!verifiedStream.destroyed) verifiedStream.destroy();
                    if (!nodeStream.destroyed) nodeStream.destroy();
                };

                return {
                    mode,
                    outputEncoding: "opus-packets",
                    stream: demuxer,
                    probe,
                    cleanup,
                };
            }

            // Header sniff revealed non-passthrough format: fall through into FFmpeg via verifiedStream
            return this.spawnFfmpegPipeline({
                inputSource: "pipe:0",
                pipeStream: verifiedStream,
                isHttpInput: false,
                seekSeconds: 0,
                volumePercent,
                qualityProfile,
                filters: request.filters,
                equalizer: request.equalizer,
                normalizeAudio: request.normalizeAudio,
                useInlinePcm,
                probe,
                signal: request.signal,
            });
        }

        // 3. FFmpeg HTTP/file transcode / DSP / fast input seek
        return this.spawnFfmpegPipeline({
            inputSource: descriptor.url,
            inputHeaders: descriptor.headers,
            isHttpInput: isHttp,
            seekSeconds,
            volumePercent,
            qualityProfile,
            filters: request.filters,
            equalizer: request.equalizer,
            normalizeAudio: request.normalizeAudio,
            useInlinePcm,
            probe: hintProbe,
            signal: request.signal,
        });
    }

    private spawnFfmpegPipeline(params: {
        inputSource: string;
        inputHeaders?: Record<string, string>;
        pipeStream?: Readable;
        isHttpInput: boolean;
        seekSeconds: number;
        volumePercent: number;
        qualityProfile: AudioQualityProfile;
        filters?: AudioFiltersState;
        equalizer?: readonly EqualizerBand[];
        normalizeAudio?: boolean;
        useInlinePcm: boolean;
        probe: ProbeResult;
        signal?: AbortSignal;
    }): PreparedAudioStream {
        const outputMode = params.useInlinePcm ? "s16le-pcm" : "ogg-opus";
        const ffmpegArgs = buildFfmpegArgs({
            inputSource: params.inputSource,
            inputHeaders: params.inputHeaders,
            seekSeconds: params.seekSeconds,
            outputMode,
            qualityProfile: params.qualityProfile,
            filters: params.filters,
            equalizer: params.equalizer,
            normalizeAudio: params.normalizeAudio,
            // When inline PCM transform is active, keep FFmpeg unity gain so live VolumeTransform smoothly controls gain
            volumePercent: params.useInlinePcm ? 100 : params.volumePercent,
            isHttpInput: params.isHttpInput,
        });

        const handle = this.supervisor.spawnManaged(this.ffmpegPath, ffmpegArgs, {
            pipeInput: Boolean(params.pipeStream),
            signal: params.signal,
            tag: "ffmpeg",
        });

        if (params.pipeStream && handle.child.stdin) {
            const stdin = handle.child.stdin;
            stdin.on("error", () => {
                // Suppress EPIPE when FFmpeg closes stdin early (e.g., on abort/skip)
            });
            params.pipeStream.on("error", (err) => {
                if (!stdin.destroyed) stdin.destroy(err);
            });
            params.pipeStream.pipe(stdin);
        }

        if (params.useInlinePcm) {
            const volumeTransform = new SmoothVolumeTransform({
                initialVolumePercent: params.volumePercent,
            });
            handle.stdout.on("error", (err) => {
                if (!volumeTransform.destroyed) volumeTransform.destroy(err);
            });
            handle.stdout.pipe(volumeTransform);

            const cleanup = async () => {
                if (!volumeTransform.destroyed) volumeTransform.destroy();
                if (params.pipeStream && !params.pipeStream.destroyed) params.pipeStream.destroy();
                await handle.kill();
            };

            return {
                mode: "ffmpeg-pcm-inline",
                outputEncoding: "s16le-pcm",
                stream: volumeTransform,
                probe: params.probe,
                processId: handle.id,
                volumeTransform,
                cleanup,
            };
        }

        const demuxer = new prism.opus.OggDemuxer();
        handle.stdout.on("error", (err) => {
            if (!demuxer.destroyed) demuxer.destroy(err);
        });
        handle.child.once("close", (code) => {
            if (code !== 0 && code !== null && !params.signal?.aborted) {
                const stderr = handle.getStderr().trim();
                this.logger?.debug({ code, stderr }, "FFmpeg pipeline terminated abnormally");
            }
        });
        handle.stdout.pipe(demuxer);

        const cleanup = async () => {
            if (!demuxer.destroyed) demuxer.destroy();
            if (params.pipeStream && !params.pipeStream.destroyed) params.pipeStream.destroy();
            await handle.kill();
        };

        return {
            mode: "ffmpeg-ogg-opus",
            outputEncoding: "opus-packets",
            stream: demuxer,
            probe: params.probe,
            processId: handle.id,
            cleanup,
        };
    }
}
