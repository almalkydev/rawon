import {
    BOT_SETTINGS_DEFAULTS,
    createDefaultGuildConfig,
    createDefaultPlayerState,
    formatSearchProvider,
    I18nService,
    normalizeHexColor,
    parseSearchProviderInput,
    SUPPORTED_LOCALES,
} from "@rawon/config";
import { describe, expect, it } from "vitest";

describe("Config Defaults & I18nService", () => {
    it("provides valid defaults and normalizes hex colors and search provider inputs", () => {
        expect(BOT_SETTINGS_DEFAULTS.defaultVolume).toBe(100);
        expect(BOT_SETTINGS_DEFAULTS.defaultQualityProfile).toBe("fidelity");
        expect(BOT_SETTINGS_DEFAULTS.defaultNormalizeAudio).toBe(false);

        const ps = createDefaultPlayerState();
        expect(ps.loopMode).toBe("OFF");
        expect(ps.volume).toBe(100);
        expect(ps.filters).toEqual({});

        const gc = createDefaultGuildConfig("123456");
        expect(gc.guildId).toBe("123456");
        expect(gc.maxQueueSize).toBe(500);
        expect(gc.rcExclusions.deleteRequestMessages).toBe(true);

        expect(normalizeHexColor("#ff00aa")).toBe("FF00AA");
        expect(normalizeHexColor("7289da")).toBe("7289DA");
        expect(normalizeHexColor("invalid")).toBeNull();

        expect(parseSearchProviderInput("YTM")).toBe("dsp");
        expect(parseSearchProviderInput("youtube")).toBe("direct");
        expect(parseSearchProviderInput("reset")).toBe("reset");
        expect(parseSearchProviderInput("unknown")).toBeNull();
        expect(formatSearchProvider("dsp")).toContain("YouTube Music");
    });

    it("loads all 14 supported locales, merges V2 additions, and formats mustache + ICU placeholders", () => {
        const i18n = new I18nService("en-US");
        expect(SUPPORTED_LOCALES).toHaveLength(14);

        for (const locale of SUPPORTED_LOCALES) {
            expect(i18n.resolveLocale(locale)).toBe(locale);
            const title = i18n.translate("requestChannel.title", locale);
            expect(title.length).toBeGreaterThan(0);
            expect(title).not.toBe("requestChannel.title");
        }

        // Alias normalization
        expect(i18n.resolveLocale("en-GB")).toBe("en-US");
        expect(i18n.resolveLocale("id")).toBe("id-ID");
        expect(i18n.resolveLocale("pt")).toBe("pt-BR");

        // Scoped translator & fallback to en-US V2 addition keys
        const tId = i18n.scoped("id-ID");
        expect(tId("requestChannel.recoveringBadge")).toBe("Recovering Stream...");

        // Discord command description localizations must respect maxLength
        const locs = i18n.getDiscordLocalizations("commands.music.play.description", 100);
        expect(Object.keys(locs).length).toBeGreaterThanOrEqual(10);
        for (const text of Object.values(locs)) {
            expect(text).toBeDefined();
            expect((text ?? "").length).toBeLessThanOrEqual(100);
        }
    });
});
