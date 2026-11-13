import { normalizeHexColor, parseSearchProviderInput } from "@rawon/config";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

function renderSetupSummary(
    settings: Awaited<ReturnType<import("@rawon/database").DatabaseStore["getBotSettings"]>>,
): string {
    return [
        `- \`embedcolor\`: \`#${settings.embedColor}\``,
        `- \`yesemoji\`: ${settings.yesEmoji}`,
        `- \`noemoji\`: ${settings.noEmoji}`,
        `- \`altprefix\`: ${settings.altPrefix.map((p) => `\`${p}\``).join(", ") || "`none`"}`,
        `- \`splash\`: \`${settings.requestChannelSplash || "none"}\``,
        `- \`defaultvolume\`: \`${settings.defaultVolume}%\``,
        `- \`selectiontype\`: \`${settings.musicSelectionType}\``,
        `- \`searchprovider\`: \`${settings.searchProvider}\``,
        `- \`alwayson\`: \`${settings.alwaysOn}\``,
        `- \`audiocache\`: \`${settings.enableAudioCache}\``,
        `- \`qualityprofile\`: \`${settings.defaultQualityProfile}\``,
        `- \`normalize\`: \`${settings.defaultNormalizeAudio}\``,
    ].join("\n");
}

export const setupCommand: CommandDefinition = {
    name: "setup",
    category: "developers",
    descriptionKey: "commands.developers.setup.description",
    usage: "commands.developers.setup.usage",
    cooldownMs: 2_000,
    guards: { devOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("setup")
            .setDescription(i18n.translate("commands.developers.setup.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.developers.setup.description", 100),
            )
            .addStringOption((opt) =>
                opt
                    .setName("setting")
                    .setDescription("Setting name (view if omitted)")
                    .setRequired(false)
                    .addChoices(
                        { name: "embedcolor", value: "embedcolor" },
                        { name: "yesemoji", value: "yesemoji" },
                        { name: "noemoji", value: "noemoji" },
                        { name: "altprefix", value: "altprefix" },
                        { name: "splash", value: "splash" },
                        { name: "defaultvolume", value: "defaultvolume" },
                        { name: "selectiontype", value: "selectiontype" },
                        { name: "searchprovider", value: "searchprovider" },
                        { name: "alwayson", value: "alwayson" },
                        { name: "audiocache", value: "audiocache" },
                        { name: "qualityprofile", value: "qualityprofile" },
                        { name: "normalize", value: "normalize" },
                        { name: "reset", value: "reset" },
                    ),
            )
            .addStringOption((opt) =>
                opt.setName("value").setDescription("New value or 'reset'").setRequired(false),
            ),
    execute: async (ctx) => {
        const setting = ctx.args.getString("setting", 0)?.toLowerCase() ?? null;
        const rawVal = ctx.args.getString("value", 1, true);
        let settings = await ctx.services.store.getBotSettings();

        if (!setting || setting === "view") {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: settings.embedColor,
                    title: ctx.t("commands.developers.setup.embedTitle"),
                    description: renderSetupSummary(settings),
                }),
                true,
            );
            return;
        }

        const isReset = rawVal?.toLowerCase() === "reset";
        let responseText: string;

        switch (setting) {
            case "reset": {
                settings = await ctx.services.store.resetBotSettings(true);
                ctx.services.sessions.refreshBotSettings(settings);
                responseText = `${settings.yesEmoji} ${ctx.t("commands.developers.setup.resetAll")}`;
                break;
            }
            case "embedcolor": {
                if (isReset || !rawVal) {
                    settings = await ctx.services.store.setBotSetting("embed_color", null);
                    responseText = ctx.t("commands.developers.setup.embedColor.reset");
                } else {
                    const normalized = normalizeHexColor(rawVal);
                    if (!normalized) {
                        responseText = `${settings.noEmoji} ${ctx.t("commands.developers.setup.embedColor.invalid")}`;
                        break;
                    }
                    settings = await ctx.services.store.setBotSetting("embed_color", normalized);
                    responseText = ctx.t("commands.developers.setup.embedColor.set", {
                        color: `#${normalized}`,
                    });
                }
                break;
            }
            case "yesemoji": {
                settings = await ctx.services.store.setBotSetting(
                    "yes_emoji",
                    isReset || !rawVal ? null : rawVal,
                );
                responseText = isReset
                    ? ctx.t("commands.developers.setup.yesEmoji.reset")
                    : ctx.t("commands.developers.setup.yesEmoji.set", { emoji: settings.yesEmoji });
                break;
            }
            case "noemoji": {
                settings = await ctx.services.store.setBotSetting(
                    "no_emoji",
                    isReset || !rawVal ? null : rawVal,
                );
                responseText = isReset
                    ? ctx.t("commands.developers.setup.noEmoji.reset")
                    : ctx.t("commands.developers.setup.noEmoji.set", { emoji: settings.noEmoji });
                break;
            }
            case "altprefix": {
                if (isReset || !rawVal) {
                    settings = await ctx.services.store.setBotSetting("alt_prefix", null);
                    responseText = ctx.t("commands.developers.setup.altPrefix.reset");
                } else {
                    const list = rawVal
                        .split(/[,\s]+/u)
                        .map((s) => s.trim())
                        .filter(Boolean);
                    if (list.length === 0) {
                        responseText = ctx.t("commands.developers.setup.altPrefix.invalid");
                        break;
                    }
                    settings = await ctx.services.store.setBotSetting(
                        "alt_prefix",
                        JSON.stringify(list),
                    );
                    responseText = ctx.t("commands.developers.setup.altPrefix.set", {
                        prefixes: list.map((p) => `\`${p}\``).join(", "),
                    });
                }
                break;
            }
            case "splash": {
                if (isReset || !rawVal) {
                    settings = await ctx.services.store.setBotSetting(
                        "request_channel_splash",
                        null,
                    );
                    responseText = ctx.t("commands.developers.setup.splash.reset");
                } else if (!/^https?:\/\//iu.test(rawVal)) {
                    responseText = ctx.t("commands.developers.setup.splash.invalid");
                } else {
                    settings = await ctx.services.store.setBotSetting(
                        "request_channel_splash",
                        rawVal,
                    );
                    responseText = ctx.t("commands.developers.setup.splash.set");
                }
                break;
            }
            case "defaultvolume": {
                if (isReset) {
                    settings = await ctx.services.store.setBotSetting("default_volume", null);
                    responseText = ctx.t("commands.developers.setup.defaultVolume.reset");
                } else {
                    const vol = Number(rawVal);
                    if (!Number.isFinite(vol) || vol < 1 || vol > 200) {
                        responseText = ctx.t("commands.developers.setup.defaultVolume.invalid");
                        break;
                    }
                    settings = await ctx.services.store.setBotSetting(
                        "default_volume",
                        String(Math.round(vol)),
                    );
                    responseText = ctx.t("commands.developers.setup.defaultVolume.set", {
                        volume: `\`${settings.defaultVolume}%\``,
                    });
                }
                break;
            }
            case "selectiontype": {
                if (isReset) {
                    settings = await ctx.services.store.setBotSetting("music_selection_type", null);
                    responseText = ctx.t("commands.developers.setup.selectionType.reset");
                } else if (rawVal !== "message" && rawVal !== "selectmenu") {
                    responseText = ctx.t("commands.developers.setup.selectionType.invalid");
                } else {
                    settings = await ctx.services.store.setBotSetting(
                        "music_selection_type",
                        rawVal,
                    );
                    responseText = ctx.t("commands.developers.setup.selectionType.set", {
                        type: `\`${rawVal}\``,
                    });
                }
                break;
            }
            case "searchprovider": {
                if (isReset) {
                    settings = await ctx.services.store.setBotSetting("search_provider", null);
                    responseText = ctx.t("commands.developers.setup.searchProvider.reset");
                } else {
                    const mode = rawVal ? parseSearchProviderInput(rawVal) : null;
                    if (!mode) {
                        responseText = ctx.t("commands.developers.setup.searchProvider.invalid");
                        break;
                    }
                    settings = await ctx.services.store.setBotSetting("search_provider", mode);
                    responseText = ctx.t("commands.developers.setup.searchProvider.set", {
                        provider: `\`${mode.toUpperCase()}\``,
                    });
                }
                break;
            }
            case "alwayson": {
                const next =
                    rawVal === "on" || rawVal === "true" || rawVal === "enable"
                        ? true
                        : rawVal === "off" || rawVal === "false" || rawVal === "disable"
                          ? false
                          : !settings.alwaysOn;
                settings = await ctx.services.store.setBotSetting("always_on", next ? "1" : "0");
                responseText = ctx.t("commands.developers.setup.alwaysOn.set", {
                    state: ctx.t(
                        next
                            ? "commands.developers.setup.alwaysOn.enabled"
                            : "commands.developers.setup.alwaysOn.disabled",
                    ),
                });
                break;
            }
            case "audiocache": {
                const next =
                    rawVal === "on" || rawVal === "true" || rawVal === "enable"
                        ? true
                        : rawVal === "off" || rawVal === "false" || rawVal === "disable"
                          ? false
                          : !settings.enableAudioCache;
                settings = await ctx.services.store.setBotSetting(
                    "enable_audio_cache",
                    next ? "1" : "0",
                );
                responseText = ctx.t("commands.developers.setup.audioCache.set", {
                    state: ctx.t(
                        next
                            ? "commands.developers.setup.audioCache.enabled"
                            : "commands.developers.setup.audioCache.disabled",
                    ),
                });
                break;
            }
            case "qualityprofile": {
                if (rawVal !== "fidelity" && rawVal !== "balanced" && rawVal !== "low-bandwidth") {
                    responseText = ctx.t("commands.developers.setup.qualityProfile.invalid");
                    break;
                }
                settings = await ctx.services.store.setBotSetting(
                    "default_quality_profile",
                    rawVal,
                );
                responseText = ctx.t("commands.developers.setup.qualityProfile.set", {
                    profile: rawVal,
                });
                break;
            }
            case "normalize": {
                const next =
                    rawVal === "on" || rawVal === "true" || rawVal === "enable"
                        ? true
                        : rawVal === "off" || rawVal === "false" || rawVal === "disable"
                          ? false
                          : !settings.defaultNormalizeAudio;
                settings = await ctx.services.store.setBotSetting(
                    "default_normalize_audio",
                    next ? "1" : "0",
                );
                responseText = ctx.t("commands.developers.setup.normalizeAudio.set", {
                    state: ctx.t(next ? "reusable.enabled" : "reusable.disabled"),
                });
                break;
            }
            default: {
                responseText = ctx.t("commands.developers.setup.unknownSetting", {
                    command: `\`${ctx.prefix}setup\``,
                });
                break;
            }
        }

        ctx.services.sessions.refreshBotSettings(settings);
        await ctx.services.coordinator
            .publishEvent({
                type: "settings_updated",
                payload: { updatedSetting: setting },
                originBotId: ctx.runtime.botId,
                timestamp: Date.now(),
            })
            .catch(() => undefined);

        await ctx.reply(
            buildNoticeContainer({
                colorHex: settings.embedColor,
                title: ctx.t("commands.developers.setup.embedTitle"),
                description: responseText,
            }),
            true,
        );
    },
};
