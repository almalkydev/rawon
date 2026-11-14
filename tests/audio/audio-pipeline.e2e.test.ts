import { spawnSync } from "node:child_process";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AudioPipeline, ProcessSupervisor } from "@rawon/audio-engine";
import { AudioEngineError, type StreamDescriptor } from "@rawon/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let workDir = "";
let oggOpusPath = "";
let webmOpusPath = "";
let monoWavPath = "";
let mp3Path = "";

async function collectChunks(stream: NodeJS.ReadableStream): Promise<Buffer[]> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks;
}

function assertValidOpusPackets(packets: Buffer[], minPackets: number): void {
    expect(packets.length).toBeGreaterThanOrEqual(minPackets);
    let stereoCount = 0;
    for (const pkt of packets) {
        expect(pkt.length).toBeGreaterThan(0);
        // RFC 6716 Section 3.1: bit 2 (0x04) of the TOC byte indicates stereo (c=1 -> 2 channels)
        if (((pkt[0] ?? 0) & 0x04) !== 0) {
            stereoCount += 1;
        }
    }
    // Majority of encoded frames from stereo 48 kHz encoder must carry the stereo bit
    expect(stereoCount).toBeGreaterThan(Math.floor(packets.length * 0.5));
}

function runFfmpeg(ffmpegExe: string, args: string[]): void {
    const res = spawnSync(ffmpegExe, ["-y", "-hide_banner", "-loglevel", "error", ...args], {
        windowsHide: true,
    });
    if (res.status !== 0) {
        throw new Error(`ffmpeg failed (${args.join(" ")}): ${res.stderr?.toString()}`);
    }
}

beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "rawon-audio-e2e-"));
    const pipeline = new AudioPipeline();
    const ffmpeg = pipeline.getFfmpegExecutable();

    oggOpusPath = join(workDir, "stereo_48k.ogg");
    webmOpusPath = join(workDir, "stereo_48k.webm");
    monoWavPath = join(workDir, "mono_22k.wav");
    mp3Path = join(workDir, "stereo_44k.mp3");

    runFfmpeg(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=4",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        oggOpusPath,
    ]);

    runFfmpeg(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=523.25:sample_rate=48000:duration=4",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "libopus",
        "-b:a",
        "96k",
        "-f",
        "webm",
        webmOpusPath,
    ]);

    runFfmpeg(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=330:sample_rate=22050:duration=3",
        "-ac",
        "1",
        "-ar",
        "22050",
        "-c:a",
        "pcm_s16le",
        monoWavPath,
    ]);

    runFfmpeg(ffmpeg, [
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=261.63:sample_rate=44100:duration=6",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
        mp3Path,
    ]);
});

afterAll(() => {
    if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

describe("AudioPipeline End-to-End with FFmpeg & Opus", () => {
    it("demuxes Ogg/Opus and WebM/Opus into raw Opus packets via zero-FFmpeg passthrough", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });

        const oggDesc: StreamDescriptor = {
            sourceType: "cache",
            url: "https://example.com/a.ogg",
            canonicalKey: "test:ogg",
            container: "ogg",
            codec: "opus",
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 4,
            isLive: false,
            seekable: true,
            directPassthroughEligible: true,
            cacheFilePath: oggOpusPath,
            resolvedAt: Date.now(),
        };

        const oggPrepared = await pipeline.preparePlaybackStream({
            descriptor: oggDesc,
            seekSeconds: 0,
            volumePercent: 100,
        });
        expect(oggPrepared.mode).toBe("passthrough-ogg-opus");
        expect(oggPrepared.outputEncoding).toBe("opus-packets");
        expect(supervisor.getActiveCount()).toBe(0);

        const oggPackets = await collectChunks(oggPrepared.stream);
        assertValidOpusPackets(oggPackets, 150);
        await oggPrepared.cleanup();

        const webmDesc: StreamDescriptor = {
            sourceType: "url",
            url: "https://example.com/a.webm",
            canonicalKey: "test:webm",
            container: "webm",
            codec: "opus",
            sampleRate: 48_000,
            channels: 2,
            durationSeconds: 4,
            isLive: false,
            seekable: true,
            directPassthroughEligible: true,
            resolvedAt: Date.now(),
        };

        const webmPrepared = await pipeline.preparePlaybackStream({
            descriptor: webmDesc,
            sourceStream: createReadStream(webmOpusPath),
            seekSeconds: 0,
            volumePercent: 100,
        });
        expect(webmPrepared.mode).toBe("passthrough-webm-opus");
        expect(webmPrepared.outputEncoding).toBe("opus-packets");
        expect(supervisor.getActiveCount()).toBe(0);

        const webmPackets = await collectChunks(webmPrepared.stream);
        assertValidOpusPackets(webmPackets, 150);
        await webmPrepared.cleanup();
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("transcodes mono WAV into 48kHz stereo Opus packets in a single FFmpeg pass", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });

        const desc: StreamDescriptor = {
            sourceType: "cache",
            url: "https://example.com/mono.wav",
            canonicalKey: "test:mono-wav",
            container: "wav",
            codec: "pcm",
            sampleRate: 22_050,
            channels: 1,
            durationSeconds: 3,
            isLive: false,
            seekable: true,
            directPassthroughEligible: false,
            cacheFilePath: monoWavPath,
            resolvedAt: Date.now(),
        };

        const prepared = await pipeline.preparePlaybackStream({
            descriptor: desc,
            qualityProfile: "fidelity",
        });

        expect(prepared.mode).toBe("ffmpeg-ogg-opus");
        expect(prepared.outputEncoding).toBe("opus-packets");
        expect(supervisor.getActiveCount()).toBe(1);

        const packets = await collectChunks(prepared.stream);
        assertValidOpusPackets(packets, 120);

        await prepared.cleanup();
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("seeks cleanly using fast input -ss and reduces remaining encoded audio proportionally", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });

        const desc: StreamDescriptor = {
            sourceType: "cache",
            url: "https://example.com/song.mp3",
            canonicalKey: "test:mp3-seek",
            container: "mp3",
            codec: "mp3",
            sampleRate: 44_100,
            channels: 2,
            durationSeconds: 6,
            isLive: false,
            seekable: true,
            directPassthroughEligible: false,
            cacheFilePath: mp3Path,
            resolvedAt: Date.now(),
        };

        const full = await pipeline.preparePlaybackStream({ descriptor: desc, seekSeconds: 0 });
        const fullPackets = await collectChunks(full.stream);
        await full.cleanup();

        const seeked = await pipeline.preparePlaybackStream({ descriptor: desc, seekSeconds: 3 });
        const seekedPackets = await collectChunks(seeked.stream);
        await seeked.cleanup();

        expect(seekedPackets.length).toBeGreaterThan(80);
        expect(seekedPackets.length).toBeLessThan(fullPackets.length * 0.65);
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("applies DSP filters, EQ, loudness normalization, and inline SmoothVolumeTransform cleanly", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });

        const desc: StreamDescriptor = {
            sourceType: "cache",
            url: "https://example.com/song.mp3",
            canonicalKey: "test:dsp",
            container: "mp3",
            codec: "mp3",
            sampleRate: 44_100,
            channels: 2,
            durationSeconds: 3,
            isLive: false,
            seekable: true,
            directPassthroughEligible: false,
            cacheFilePath: monoWavPath,
            resolvedAt: Date.now(),
        };

        const dspPrepared = await pipeline.preparePlaybackStream({
            descriptor: desc,
            filters: { bassboost: true, nightcore: true },
            equalizer: [{ frequency: 120, gainDb: 3.5, width: 1.2 }],
            normalizeAudio: true,
            volumePercent: 115,
        });
        expect(dspPrepared.mode).toBe("ffmpeg-ogg-opus");
        const dspPackets = await collectChunks(dspPrepared.stream);
        assertValidOpusPackets(dspPackets, 90);
        await dspPrepared.cleanup();

        const inlinePrepared = await pipeline.preparePlaybackStream({
            descriptor: desc,
            enableRealtimeVolumeTransform: true,
            volumePercent: 80,
        });
        expect(inlinePrepared.mode).toBe("ffmpeg-pcm-inline");
        expect(inlinePrepared.outputEncoding).toBe("s16le-pcm");
        expect(inlinePrepared.volumeTransform).toBeDefined();
        inlinePrepared.volumeTransform?.setVolumePercent(140);
        const pcmOut = Buffer.concat(await collectChunks(inlinePrepared.stream));
        expect(pcmOut.length % 4).toBe(0);
        expect(pcmOut.length).toBeGreaterThan(100_000);
        await inlinePrepared.cleanup();
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("immediately kills FFmpeg child processes when AbortSignal fires on track skip (zero zombies)", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });
        const longWav = join(workDir, "long_30s.wav");

        runFfmpeg(pipeline.getFfmpegExecutable(), [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=30",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            longWav,
        ]);

        const ac = new AbortController();
        const prepared = await pipeline.preparePlaybackStream({
            descriptor: {
                sourceType: "cache",
                url: "https://example.com/long.wav",
                canonicalKey: "test:abort",
                container: "wav",
                codec: "pcm",
                sampleRate: 48_000,
                channels: 2,
                durationSeconds: 30,
                isLive: false,
                seekable: true,
                directPassthroughEligible: false,
                cacheFilePath: longWav,
                resolvedAt: Date.now(),
            },
            normalizeAudio: true,
            signal: ac.signal,
        });

        expect(supervisor.getActiveCount()).toBe(1);

        await new Promise<void>((resolve) => {
            prepared.stream.once("data", () => resolve());
        });
        ac.abort();
        await prepared.cleanup();

        await new Promise((r) => setTimeout(r, 80));
        expect(supervisor.getActiveCount()).toBe(0);
    });

    it("emits an error instead of silent EOF when FFmpeg exits non-zero on non-403 decode failure", async () => {
        const supervisor = new ProcessSupervisor();
        const pipeline = new AudioPipeline({ supervisor });
        const corruptPath = join(workDir, "corrupt_input.ogg");
        writeFileSync(corruptPath, "not-valid-ogg-or-media-bytes");

        const prepared = await pipeline.preparePlaybackStream({
            descriptor: {
                sourceType: "cache",
                url: "https://example.com/corrupt.ogg",
                canonicalKey: "test:corrupt",
                container: "ogg",
                codec: "opus",
                sampleRate: 48_000,
                channels: 2,
                durationSeconds: 10,
                isLive: false,
                seekable: true,
                directPassthroughEligible: false,
                cacheFilePath: corruptPath,
                resolvedAt: Date.now(),
            },
            normalizeAudio: true,
        });

        await expect(collectChunks(prepared.stream)).rejects.toThrow(AudioEngineError);
        await prepared.cleanup();
        expect(supervisor.getActiveCount()).toBe(0);
    });
});
