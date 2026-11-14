import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const SUPPORTED_LOCALES = [
    "en-US",
    "es-ES",
    "fr-FR",
    "id-ID",
    "ja-JP",
    "ko-KR",
    "ms-MY",
    "pt-BR",
    "ru-RU",
    "tr-TR",
    "uk-UA",
    "vi-VN",
    "zh-CN",
    "zh-TW",
] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

type JsonObject = Record<string, unknown>;

const V2_ADDITIONS_EN: JsonObject = {
    common: {
        previous: "Previous",
        next: "Next",
    },
    commands: {
        music: {
            previous: {
                description: "Play the previous song from history",
                noPrevious: "There is no previous song in history.",
                previousMessage: "Playing previous track: {song}",
            },
        },
        developers: {
            setup: {
                qualityProfile: {
                    set: "Default audio quality profile set to `{profile}`.",
                    invalid: "Quality profile must be `fidelity`, `balanced`, or `low-bandwidth`.",
                },
                normalizeAudio: {
                    set: "Loudness normalization default has been {state}.",
                },
            },
            login: {
                slashCookiesDescription:
                    "Import Netscape cookies.txt for headless/VPS YouTube playback",
                cookiesMissingInput:
                    "Attach a Netscape `cookies.txt` file or pass cookie text (`/login cookies file:...`).",
                cookiesImported: "YouTube cookies imported and activated for playback.",
            },
        },
    },
    requestChannel: {
        previousButton: "Previous",
        pauseButton: "Pause",
        resumeButton: "Resume",
        skipButton: "Skip",
        stopButton: "Stop",
        loopButton: "Loop",
        shuffleButton: "Shuffle",
        autoplayButton: "Auto-play",
        queueButton: "Queue",
        lyricsButton: "Lyrics",
        filtersButton: "Filters",
        resetFiltersButton: "Reset All Filters",
        volumeDownButton: "Vol -",
        volumeUpButton: "Vol +",
        volumeModalButton: "Volume",
        removeButton: "Remove",
        upNext: "Up Next",
        nowPlayingBadge: "Now Playing",
        pausedBadge: "Paused",
        bufferingBadge: "Buffering...",
        recoveringBadge: "Recovering Stream...",
        rateLimited: "You are sending requests too fast. Please wait {seconds}s.",
        queueLimitReached: "Queue limit ({limit} tracks) reached for this server.",
        filtersTitle: "Audio Filters & Profile",
        selectFiltersPlaceholder: "Select filters to toggle...",
        noFiltersActive: "None",
        volumeModalTitle: "Set Playback Volume",
        volumeModalLabel: "Volume percentage (1 - 200)",
        invalidVolumeModal: "Please enter a valid number between 1 and 200.",
        partialFailure: "Some items could not be resolved: {failed}",
    },
    music: {
        recoveringStream: "Stream interrupted for **{title}**; recovering (attempt {attempt})...",
        trackLoadFailed: "Could not play **{title}**: {reason}",
        emptyVcLeaving: "Voice channel is empty; pausing and leaving soon if nobody rejoins.",
    },
};

function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: JsonObject, additions: JsonObject): JsonObject {
    const out: JsonObject = { ...base };
    for (const [key, val] of Object.entries(additions)) {
        const existing = out[key];
        if (isPlainObject(existing) && isPlainObject(val)) {
            out[key] = deepMerge(existing, val);
        } else if (!(key in out)) {
            out[key] = val;
        }
    }
    return out;
}

function lookupNested(obj: JsonObject, key: string): string | null {
    const parts = key.split(".");
    let cur: unknown = obj;
    for (const part of parts) {
        if (!isPlainObject(cur) || !(part in cur)) {
            return null;
        }
        cur = cur[part];
    }
    return typeof cur === "string" ? cur : null;
}

function formatIcuOrMustache(
    template: string,
    params?: Record<string, string | number | undefined>,
): string {
    if (!params) {
        return template;
    }

    let output = "";
    let i = 0;

    while (i < template.length) {
        const ch = template[i];
        if (ch !== "{") {
            output += ch;
            i += 1;
            continue;
        }

        // Find matching closing brace accounting for nested { ... }
        let depth = 1;
        let j = i + 1;
        while (j < template.length && depth > 0) {
            if (template[j] === "{") depth += 1;
            else if (template[j] === "}") depth -= 1;
            j += 1;
        }

        if (depth !== 0) {
            output += template.slice(i);
            break;
        }

        const inner = template.slice(i + 1, j - 1).trim();
        const selectMatch = /^([a-zA-Z0-9_]+)\s*,\s*select\s*,\s*([\s\S]+)$/u.exec(inner);

        if (selectMatch) {
            const varName = selectMatch[1] ?? "";
            const body = selectMatch[2] ?? "";
            const actualValue = String(params[varName] ?? "");
            const cases = new Map<string, string>();
            let pos = 0;

            while (pos < body.length) {
                while (pos < body.length && /\s/u.test(body[pos] ?? "")) pos += 1;
                if (pos >= body.length) break;
                const keyStart = pos;
                while (pos < body.length && !/[\s{]/u.test(body[pos] ?? "")) pos += 1;
                const caseKey = body.slice(keyStart, pos);
                while (pos < body.length && /\s/u.test(body[pos] ?? "")) pos += 1;
                if (body[pos] !== "{") break;

                let caseDepth = 1;
                const valStart = pos + 1;
                pos += 1;
                while (pos < body.length && caseDepth > 0) {
                    if (body[pos] === "{") caseDepth += 1;
                    else if (body[pos] === "}") caseDepth -= 1;
                    pos += 1;
                }
                const caseVal = body.slice(valStart, pos - 1);
                cases.set(caseKey, caseVal);
            }

            const chosen = cases.get(actualValue) ?? cases.get("other") ?? "";
            output += formatIcuOrMustache(chosen, params);
        } else if (inner in params && params[inner] !== undefined) {
            output += String(params[inner]);
        } else {
            output += `{${inner}}`;
        }

        i = j;
    }

    return output;
}

const RAWON_TO_DISCORD_LOCALE: Record<SupportedLocale, string | null> = {
    "en-US": "en-US",
    "es-ES": "es-ES",
    "fr-FR": "fr",
    "id-ID": "id",
    "ja-JP": "ja",
    "ko-KR": "ko",
    "ms-MY": null,
    "pt-BR": "pt-BR",
    "ru-RU": "ru",
    "tr-TR": "tr",
    "uk-UA": "uk",
    "vi-VN": "vi",
    "zh-CN": "zh-CN",
    "zh-TW": "zh-TW",
};

export type ScopedTranslator = (
    key: string,
    params?: Record<string, string | number | undefined>,
) => string;

export class I18nService {
    private readonly bundles = new Map<SupportedLocale, JsonObject>();
    private readonly defaultLocale: SupportedLocale;

    public constructor(defaultLocale: SupportedLocale = "en-US", localesDir?: string) {
        this.defaultLocale = defaultLocale;
        const baseDir = localesDir ?? resolve(import.meta.dirname, "../locales");

        for (const locale of SUPPORTED_LOCALES) {
            const filePath = resolve(baseDir, `${locale}.json`);
            if (!existsSync(filePath)) {
                continue;
            }
            const parsed = JSON.parse(readFileSync(filePath, "utf8")) as JsonObject;
            this.bundles.set(locale, deepMerge(parsed, V2_ADDITIONS_EN));
        }
    }

    public resolveLocale(locale?: string | null, fallback?: string | null): SupportedLocale {
        const matchTag = (candidate: string | null | undefined): SupportedLocale | null => {
            if (!candidate) return null;
            const normalized = candidate.trim().toLowerCase().replaceAll("_", "-");
            const exact = SUPPORTED_LOCALES.find((loc) => loc.toLowerCase() === normalized);
            if (exact) return exact;
            const primary = normalized.split("-")[0];
            if (!primary) return null;
            return (
                SUPPORTED_LOCALES.find((loc) => loc.toLowerCase().startsWith(`${primary}-`)) ?? null
            );
        };

        const matched = matchTag(locale);
        if (matched) {
            return matched;
        }
        const matchedFallback = matchTag(fallback);
        if (matchedFallback) {
            return matchedFallback;
        }
        return this.defaultLocale;
    }

    public translate(
        key: string,
        locale?: string | null,
        params?: Record<string, string | number | undefined>,
    ): string {
        const resolved = this.resolveLocale(locale);
        const targetBundle = this.bundles.get(resolved);
        const fallbackBundle = this.bundles.get("en-US");

        const raw =
            (targetBundle ? lookupNested(targetBundle, key) : null) ??
            (fallbackBundle ? lookupNested(fallbackBundle, key) : null) ??
            key;

        return formatIcuOrMustache(raw, params);
    }

    public scoped(locale?: string | null): ScopedTranslator {
        const resolved = this.resolveLocale(locale);
        return (key: string, params?: Record<string, string | number | undefined>): string =>
            this.translate(key, resolved, params);
    }

    public getDiscordLocalizations(key: string, maxLength = 100): Partial<Record<string, string>> {
        const result: Partial<Record<string, string>> = {};
        for (const locale of SUPPORTED_LOCALES) {
            const discordLocale = RAWON_TO_DISCORD_LOCALE[locale];
            if (!discordLocale) continue;
            const bundle = this.bundles.get(locale);
            const val = bundle ? lookupNested(bundle, key) : null;
            if (val) {
                const formatted = formatIcuOrMustache(val).slice(0, maxLength);
                if (formatted.length > 0) {
                    result[discordLocale] = formatted;
                }
            }
        }
        return result;
    }
}
