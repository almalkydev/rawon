import type {
    AudioFiltersState,
    AudioQualityProfile,
    DspOptions,
    EqualizerBand,
    FilterName,
} from "@rawon/shared";

export const FFMPEG_FILTER_PRESETS: Record<FilterName, string> = {
    bassboost: "bass=g=7.5",
    nightcore: "aresample=48000,asetrate=48000*1.25",
    vaporwave: "aresample=48000,asetrate=48000*0.8",
    treble: "treble=g=5",
    "8d": "apulsator=hz=0.08",
    reverse: "areverse",
    surround: "surround",
    haas: "haas",
    phaser: "aphaser=in_gain=0.4",
    gate: "agate",
    mcompand: "mcompand",
    flanger: "flanger",
    tremolo: "tremolo",
    karaoke: "stereotools=mlev=0.1",
    vibrato: "vibrato=f=6.5",
    echo: "aecho=0.8:0.9:1000:0.3",
    spedup: "aresample=48000,asetrate=48000*10/9",
    slowed: "aresample=48000,asetrate=48000*0.9",
    reverb: "aecho=0.8:0.88:60|120|180:0.3|0.2|0.1",
};

export interface QualityProfileSettings {
    bitrateKbps: number;
    compressionLevel: number;
    frameDurationMs: number;
}

export const QUALITY_PROFILES: Record<AudioQualityProfile, QualityProfileSettings> = {
    fidelity: {
        bitrateKbps: 128,
        compressionLevel: 10,
        frameDurationMs: 20,
    },
    balanced: {
        bitrateKbps: 96,
        compressionLevel: 8,
        frameDurationMs: 20,
    },
    "low-bandwidth": {
        bitrateKbps: 64,
        compressionLevel: 5,
        frameDurationMs: 20,
    },
};

export function hasAnyActiveDsp(dsp: Partial<DspOptions> | undefined): boolean {
    if (!dsp) return false;
    if (dsp.normalizeAudio) return true;
    if (dsp.equalizer?.some((b) => Math.abs(b.gainDb) > 0.01)) return true;
    if (dsp.filters) {
        for (const val of Object.values(dsp.filters)) {
            if (val === true) return true;
        }
    }
    return false;
}

export function volumePercentToAmplitude(volumePercent: number): number {
    const clamped = Math.max(0, Math.min(200, volumePercent));
    if (clamped === 0) return 0;
    if (clamped === 100) return 1;
    // Perceptual curve smoothly matching human loudness perception while keeping 100% unity gain exact
    return (clamped / 100) ** 1.4;
}

export function buildEqualizerFilters(bands: readonly EqualizerBand[]): string[] {
    const filters: string[] = [];
    for (const band of bands) {
        if (!Number.isFinite(band.frequency) || !Number.isFinite(band.gainDb)) continue;
        if (Math.abs(band.gainDb) < 0.05) continue;
        const clampedFreq = Math.max(20, Math.min(20_000, Math.round(band.frequency)));
        const clampedGain = Math.max(-18, Math.min(18, band.gainDb));
        const width = Math.max(0.1, Math.min(4, band.width ?? 1));
        filters.push(
            `equalizer=f=${clampedFreq}:width_type=o:w=${width}:g=${clampedGain.toFixed(2)}`,
        );
    }
    return filters;
}

export function buildFilterChain(options: {
    filters?: AudioFiltersState;
    equalizer?: readonly EqualizerBand[];
    normalizeAudio?: boolean;
    volumePercent?: number;
}): string[] {
    const chain: string[] = [];
    let needsLimiter = false;

    if (options.filters) {
        for (const [name, enabled] of Object.entries(options.filters)) {
            if (enabled !== true) continue;
            const expr = FFMPEG_FILTER_PRESETS[name as FilterName];
            if (expr) {
                chain.push(expr);
                if (name === "bassboost" || name === "treble") {
                    needsLimiter = true;
                }
            }
        }
    }

    if (options.equalizer && options.equalizer.length > 0) {
        const eq = buildEqualizerFilters(options.equalizer);
        chain.push(...eq);
        if (options.equalizer.some((b) => b.gainDb > 0.5)) {
            needsLimiter = true;
        }
    }

    if (options.normalizeAudio) {
        chain.push("loudnorm=I=-14:TP=-1.5:LRA=11");
    }

    const vol = options.volumePercent ?? 100;
    if (Math.abs(vol - 100) > 0.1) {
        const amp = volumePercentToAmplitude(vol);
        chain.push(`volume=${amp.toFixed(4)}`);
        if (vol > 100) {
            needsLimiter = true;
        }
    }

    if (needsLimiter) {
        // Gentle transparent peak limiter to guarantee zero hard-clipping
        chain.push("alimiter=level_in=1:level_out=1:limit=0.97:attack=5:release=50");
    }

    return chain;
}

export interface BuildFfmpegArgsOptions {
    inputSource: string; // "-" for stdin, file path, or http(s) URL
    inputHeaders?: Record<string, string>;
    seekSeconds?: number;
    outputMode: "ogg-opus" | "s16le-pcm";
    copyOpus?: boolean;
    qualityProfile?: AudioQualityProfile;
    filters?: AudioFiltersState;
    equalizer?: readonly EqualizerBand[];
    normalizeAudio?: boolean;
    volumePercent?: number;
    isHttpInput?: boolean;
}

export function buildFfmpegArgs(options: BuildFfmpegArgsOptions): string[] {
    const args: string[] = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-fflags",
        "+discardcorrupt",
    ];

    if (options.isHttpInput) {
        args.push(
            "-reconnect",
            "1",
            "-reconnect_streamed",
            "1",
            "-reconnect_on_network_error",
            "1",
            "-reconnect_delay_max",
            "5",
            "-rw_timeout",
            "15000000",
        );
        if (options.inputHeaders && Object.keys(options.inputHeaders).length > 0) {
            const headerLines = Object.entries(options.inputHeaders)
                .map(([k, v]) => `${k}: ${v}`)
                .join("\r\n");
            args.push("-headers", `${headerLines}\r\n`);
        }
    }

    // Place fast input-side seek BEFORE -i for instant demuxing/byte seeking!
    if (options.seekSeconds && options.seekSeconds > 0) {
        args.push("-ss", options.seekSeconds.toFixed(3));
    }

    args.push("-i", options.inputSource, "-vn", "-sn", "-dn");

    if (options.copyOpus && options.outputMode === "ogg-opus") {
        args.push("-c:a", "copy", "-flush_packets", "1", "-f", "ogg", "pipe:1");
        return args;
    }

    const filterChain = buildFilterChain({
        filters: options.filters,
        equalizer: options.equalizer,
        normalizeAudio: options.normalizeAudio,
        volumePercent: options.volumePercent,
    });
    // High-precision Kaiser windowed resampler guarantees clean 44.1kHz -> 48kHz conversion without aliasing or crackles
    filterChain.push("aresample=48000:filter_type=kaiser:filter_size=64");

    args.push("-af", filterChain.join(","));

    // Discord requires 48 kHz 2-channel stereo
    args.push("-ar", "48000", "-ac", "2");

    if (options.outputMode === "ogg-opus") {
        const profile = QUALITY_PROFILES[options.qualityProfile ?? "fidelity"];
        args.push(
            "-c:a",
            "libopus",
            "-b:a",
            `${profile.bitrateKbps}k`,
            "-vbr",
            "on",
            "-compression_level",
            String(profile.compressionLevel),
            "-application",
            "audio",
            "-frame_duration",
            String(profile.frameDurationMs),
            "-flush_packets",
            "1",
            "-f",
            "ogg",
            "pipe:1",
        );
    } else {
        args.push("-f", "s16le", "-acodec", "pcm_s16le", "pipe:1");
    }

    return args;
}
