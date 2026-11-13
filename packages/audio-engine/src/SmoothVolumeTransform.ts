import { Transform, type TransformCallback } from "node:stream";
import { volumePercentToAmplitude } from "./filterBuilder.js";

/**
 * High-precision 16-bit signed little-endian stereo PCM gain transformer with
 * smooth per-frame ramping (prevents clicks and zipper noise on volume changes)
 * and soft saturation above full scale to eliminate hard clipping.
 */
export class SmoothVolumeTransform extends Transform {
    private currentGain: number;
    private targetGain: number;
    private volumePercentValue: number;
    private readonly rampSamplesPerStep: number;
    private remainder: Buffer | null = null;

    public constructor(options: { initialVolumePercent?: number; rampDurationMs?: number } = {}) {
        super({ highWaterMark: 32 * 1024 });
        const initVol = options.initialVolumePercent ?? 100;
        this.volumePercentValue = initVol;
        this.currentGain = volumePercentToAmplitude(initVol);
        this.targetGain = this.currentGain;
        const rampMs = Math.max(5, options.rampDurationMs ?? 40);
        // 48 kHz * stereo (2 samples per frame) => 96 samples/ms
        this.rampSamplesPerStep = Math.max(2, Math.floor(rampMs * 48));
    }

    public get volumePercent(): number {
        return this.volumePercentValue;
    }

    public setVolumePercent(volumePercent: number): void {
        const clamped = Math.max(0, Math.min(200, volumePercent));
        this.volumePercentValue = clamped;
        this.targetGain = volumePercentToAmplitude(clamped);
    }

    public override _transform(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: TransformCallback,
    ): void {
        // Handle odd trailing byte across chunks safely for 16-bit PCM
        const buf = this.remainder ? Buffer.concat([this.remainder, chunk]) : chunk;
        const usableLen = buf.length - (buf.length % 2);
        this.remainder = usableLen < buf.length ? buf.subarray(usableLen) : null;

        if (usableLen === 0) {
            callback();
            return;
        }

        // Fast zero-copy path when unity gain is settled
        if (Math.abs(this.currentGain - 1) < 1e-6 && Math.abs(this.targetGain - 1) < 1e-6) {
            callback(null, buf.subarray(0, usableLen));
            return;
        }

        const out = Buffer.allocUnsafe(usableLen);
        const totalSamples = usableLen / 2;

        for (let i = 0; i < totalSamples; i += 1) {
            // Smooth linear interpolation step every stereo pair
            if ((i & 1) === 0 && Math.abs(this.targetGain - this.currentGain) > 1e-5) {
                const delta = this.targetGain - this.currentGain;
                const maxStep = Math.max(Math.abs(delta) / this.rampSamplesPerStep, 0.0005);
                if (Math.abs(delta) <= maxStep) {
                    this.currentGain = this.targetGain;
                } else {
                    this.currentGain += Math.sign(delta) * maxStep;
                }
            }

            const sample = buf.readInt16LE(i * 2);
            let scaled = sample * this.currentGain;

            // Soft knee limiter near +/- 32767 to prevent harsh clipping when volume > 100%
            if (scaled > 31_000) {
                scaled = 31_000 + Math.tanh((scaled - 31_000) / 3000) * 1767;
            } else if (scaled < -31_000) {
                scaled = -31_000 - Math.tanh((-31_000 - scaled) / 3000) * 1767;
            }

            out.writeInt16LE(Math.max(-32_768, Math.min(32_767, Math.round(scaled))), i * 2);
        }

        callback(null, out);
    }

    public override _flush(callback: TransformCallback): void {
        this.remainder = null;
        callback();
    }
}
