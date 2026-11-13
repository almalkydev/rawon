import { PassThrough, type Readable } from "node:stream";
import type { StreamDescriptor } from "@rawon/shared";

export interface ProbeResult {
    container: "webm" | "ogg" | "mp4" | "mp3" | "flac" | "wav" | "unknown";
    codec: string;
    sampleRate: number;
    channels: number;
    opusPassthroughCompatible: boolean;
}

const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const OGG_MAGIC = Buffer.from("OggS", "ascii");
const OPUS_HEAD_MAGIC = Buffer.from("OpusHead", "ascii");
const FLAC_MAGIC = Buffer.from("fLaC", "ascii");
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");

export function inspectHeaderBytes(header: Buffer, hint?: Partial<StreamDescriptor>): ProbeResult {
    const channelsHint = hint?.channels ?? 2;
    const sampleRateHint = hint?.sampleRate ?? 48_000;
    const codecHint = hint?.codec?.toLowerCase() ?? "";

    // Ogg container: parse BOS OpusHead packet if present for exact channel count & rate
    if (header.length >= 4 && header.subarray(0, 4).equals(OGG_MAGIC)) {
        const opusHeadIdx = header.indexOf(OPUS_HEAD_MAGIC);
        if (opusHeadIdx !== -1 && header.length >= opusHeadIdx + 19) {
            const channels = header.readUInt8(opusHeadIdx + 9);
            const inputSampleRate = header.readUInt32LE(opusHeadIdx + 12);
            const compat = channels === 2; // Opus always outputs 48 kHz; passthrough requires stereo
            return {
                container: "ogg",
                codec: "opus",
                sampleRate: inputSampleRate || 48_000,
                channels,
                opusPassthroughCompatible: compat,
            };
        }
        return {
            container: "ogg",
            codec: codecHint || "vorbis",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible:
                codecHint.includes("opus") && channelsHint === 2 && sampleRateHint === 48_000,
        };
    }

    // WebM / Matroska EBML header
    if (header.length >= 4 && header.subarray(0, 4).equals(EBML_MAGIC)) {
        const hasOpusCodecId =
            header.includes(Buffer.from("A_OPUS", "ascii")) || codecHint.includes("opus");
        const isWebmDocType =
            header.includes(Buffer.from("webm", "ascii")) || hint?.container === "webm";
        const compat =
            hasOpusCodecId && isWebmDocType && channelsHint === 2 && sampleRateHint === 48_000;
        return {
            container: "webm",
            codec: hasOpusCodecId ? "opus" : codecHint || "unknown",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible: compat,
        };
    }

    if (header.length >= 4 && header.subarray(0, 4).equals(FLAC_MAGIC)) {
        return {
            container: "flac",
            codec: "flac",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible: false,
        };
    }

    if (header.length >= 4 && header.subarray(0, 4).equals(RIFF_MAGIC)) {
        return {
            container: "wav",
            codec: "pcm",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible: false,
        };
    }

    if (
        (header.length >= 3 && header.subarray(0, 3).toString("ascii") === "ID3") ||
        (header.length >= 2 && header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0)
    ) {
        return {
            container: "mp3",
            codec: "mp3",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible: false,
        };
    }

    if (header.length >= 8 && header.subarray(4, 8).toString("ascii") === "ftyp") {
        return {
            container: "mp4",
            codec: codecHint || "aac",
            sampleRate: sampleRateHint,
            channels: channelsHint,
            opusPassthroughCompatible: false,
        };
    }

    return {
        container: "unknown",
        codec: codecHint || "unknown",
        sampleRate: sampleRateHint,
        channels: channelsHint,
        opusPassthroughCompatible: false,
    };
}

export async function peekStreamAndProbe(
    source: Readable,
    hint?: Partial<StreamDescriptor>,
    peekBytes = 512,
): Promise<{ probe: ProbeResult; stream: Readable }> {
    const out = new PassThrough();
    const collected: Buffer[] = [];
    let total = 0;

    return new Promise((resolve, reject) => {
        let done = false;

        const finishProbe = () => {
            if (done) return;
            done = true;
            source.removeListener("data", onData);
            source.removeListener("end", onEnd);
            source.removeListener("error", onError);

            const head = Buffer.concat(collected);
            const probe = inspectHeaderBytes(head, hint);
            if (head.length > 0 && !out.destroyed) {
                out.write(head);
            }
            source.pipe(out);
            resolve({ probe, stream: out });
        };

        const onData = (chunk: Buffer) => {
            collected.push(chunk);
            total += chunk.length;
            if (total >= peekBytes) {
                source.pause();
                finishProbe();
            }
        };

        const onEnd = () => {
            finishProbe();
            out.end();
        };

        const onError = (err: Error) => {
            if (done) {
                out.destroy(err);
                return;
            }
            done = true;
            reject(err);
        };

        source.on("data", onData);
        source.once("end", onEnd);
        source.once("error", onError);
    });
}
