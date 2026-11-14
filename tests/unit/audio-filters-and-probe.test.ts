import { PassThrough } from "node:stream";
import {
    buildFfmpegArgs,
    buildFilterChain,
    canUseOpusPassthrough,
    inspectHeaderBytes,
    peekStreamAndProbe,
    SmoothVolumeTransform,
} from "@rawon/audio-engine";
import { describe, expect, it } from "vitest";

function buildOggOpusHeadHeader(channels: number, sampleRate: number): Buffer {
    const header = Buffer.alloc(64, 0);
    header.write("OggS", 0, "ascii");
    header.write("OpusHead", 28, "ascii");
    header.writeUInt8(1, 36); // version
    header.writeUInt8(channels, 37);
    header.writeUInt32LE(sampleRate, 40);
    return header;
}

describe("Audio Engine Codec Probe, Filter Builder & SmoothVolumeTransform", () => {
    it("detects Ogg/Opus passthrough compatibility vs mono/non-Opus containers", () => {
        const stereoOggOpus = buildOggOpusHeadHeader(2, 48_000);
        const probeStereo = inspectHeaderBytes(stereoOggOpus);
        expect(probeStereo).toMatchObject({
            container: "ogg",
            codec: "opus",
            channels: 2,
            opusPassthroughCompatible: true,
        });

        const monoOggOpus = buildOggOpusHeadHeader(1, 48_000);
        const probeMono = inspectHeaderBytes(monoOggOpus);
        expect(probeMono.channels).toBe(1);
        expect(probeMono.opusPassthroughCompatible).toBe(false);

        // WebM EBML header with A_OPUS & webm doctype
        const webmHeader = Buffer.concat([
            Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84]),
            Buffer.from("webm", "ascii"),
            Buffer.from([0x86]),
            Buffer.from("A_OPUS", "ascii"),
        ]);
        const webmProbe = inspectHeaderBytes(webmHeader, {
            container: "webm",
            codec: "opus",
            sampleRate: 48_000,
            channels: 2,
        });
        expect(webmProbe.opusPassthroughCompatible).toBe(true);

        expect(
            canUseOpusPassthrough({
                probe: webmProbe,
                seekSeconds: 0,
                volumePercent: 100,
                filters: {},
                equalizer: [],
                normalizeAudio: false,
                enableRealtimeVolumeTransform: false,
            }),
        ).toBe(true);

        // Seeking, non-100 volume, or DSP disables passthrough
        expect(
            canUseOpusPassthrough({
                probe: webmProbe,
                seekSeconds: 15,
                volumePercent: 100,
            }),
        ).toBe(false);
        expect(
            canUseOpusPassthrough({
                probe: webmProbe,
                seekSeconds: 0,
                volumePercent: 120,
            }),
        ).toBe(false);
        expect(
            canUseOpusPassthrough({
                probe: webmProbe,
                seekSeconds: 0,
                volumePercent: 100,
                filters: { bassboost: true },
            }),
        ).toBe(false);
    });

    it("builds high-fidelity FFmpeg filter chains with transparent peak limiting and fast input seeking", () => {
        const chain = buildFilterChain({
            filters: { bassboost: true },
            equalizer: [{ frequency: 100, gainDb: 4, width: 1.5 }],
            normalizeAudio: true,
            volumePercent: 130,
        });

        expect(chain.some((f) => f.includes("bass=g=7.5"))).toBe(true);
        expect(chain.some((f) => f.includes("equalizer=f=100"))).toBe(true);
        expect(chain.some((f) => f.includes("loudnorm=I=-14"))).toBe(true);
        expect(chain.some((f) => f.startsWith("volume="))).toBe(true);
        expect(chain.at(-1)).toContain("alimiter=");

        const args = buildFfmpegArgs({
            inputSource: "https://cdn.example.com/audio.webm",
            isHttpInput: true,
            seekSeconds: 42.5,
            outputMode: "ogg-opus",
            qualityProfile: "fidelity",
        });

        const ssIdx = args.indexOf("-ss");
        const inputIdx = args.indexOf("-i");
        expect(ssIdx).toBeGreaterThan(-1);
        expect(inputIdx).toBeGreaterThan(ssIdx); // Fast input seek BEFORE -i
        expect(args).toContain("-reconnect");
        expect(args).toContain("libopus");
        expect(args).toContain("128k");
    });

    it("smoothly scales S16LE PCM audio without hard clipping or odd-byte corruption", async () => {
        const transform = new SmoothVolumeTransform({
            initialVolumePercent: 150,
            rampDurationMs: 10,
        });

        // Build near-full-scale alternating stereo PCM samples
        const sampleCount = 64;
        const input = Buffer.alloc(sampleCount * 2);
        for (let i = 0; i < sampleCount; i += 1) {
            input.writeInt16LE(i % 2 === 0 ? 32_000 : -32_000, i * 2);
        }

        const outputs: Buffer[] = [];
        transform.on("data", (chunk: Buffer) => outputs.push(chunk));

        // Feed in odd-byte slices to verify remainder frame safety
        transform.write(input.subarray(0, 17));
        transform.write(input.subarray(17));
        transform.end();

        await new Promise<void>((resolve) => transform.once("finish", resolve));
        const combined = Buffer.concat(outputs);
        expect(combined.length).toBe(input.length);

        for (let i = 0; i < sampleCount; i += 1) {
            const val = combined.readInt16LE(i * 2);
            expect(val).toBeLessThanOrEqual(32_767);
            expect(val).toBeGreaterThanOrEqual(-32_768);
        }
    });

    it("propagates mid-stream source errors after header probing completes", async () => {
        const source = new PassThrough();
        const header = buildOggOpusHeadHeader(2, 48_000);
        const probePromise = peekStreamAndProbe(source, undefined, 64);

        source.write(header);
        const { probe, stream } = await probePromise;
        expect(probe.opusPassthroughCompatible).toBe(true);

        const receivedError = new Promise<Error>((resolve) => {
            stream.once("error", resolve);
        });
        stream.resume();

        source.emit("error", new Error("upstream socket reset"));
        const err = await receivedError;
        expect(err.message).toBe("upstream socket reset");
    });
});
