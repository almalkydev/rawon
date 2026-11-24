import { assertSafePublicUrl } from "@rawon/shared";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const loginCommand: CommandDefinition = {
    name: "login",
    category: "developers",
    descriptionKey: "commands.developers.login.description",
    usage: "commands.developers.login.usage",
    cooldownMs: 3_000,
    guards: { devOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("login")
            .setDescription(i18n.translate("commands.developers.login.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.developers.login.description", 100),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("oauth")
                    .setDescription(
                        i18n.translate("commands.developers.login.slashOauthDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("start")
                    .setDescription(
                        i18n.translate("commands.developers.login.slashStartDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("status")
                    .setDescription(
                        i18n.translate("commands.developers.login.slashStatusDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("logout")
                    .setDescription(
                        i18n.translate("commands.developers.login.slashLogoutDescription", "en-US"),
                    ),
            )
            .addSubcommand((sub) =>
                sub
                    .setName("cookies")
                    .setDescription(
                        i18n.translate(
                            "commands.developers.login.slashCookiesDescription",
                            "en-US",
                        ),
                    )
                    .addAttachmentOption((opt) =>
                        opt
                            .setName("file")
                            .setDescription("Netscape cookies.txt file exported from YouTube")
                            .setRequired(false),
                    )
                    .addStringOption((opt) =>
                        opt
                            .setName("text")
                            .setDescription("Raw or base64-encoded Netscape cookies text")
                            .setRequired(false),
                    ),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const sub = (ctx.args.getSubcommand(0) ?? "status").toLowerCase();
        const loginSvc = ctx.services.getOrCreateGoogleLoginService();
        const cookieStore = ctx.services.getCookieStore();

        if (sub === "status") {
            const status = await loginSvc.getStatus();
            const hasCookies = cookieStore.hasCookies();
            const hasOauth = loginSvc.hasOAuth();
            const stateLabel =
                status.status === "logged_in" || hasOauth
                    ? ctx.t("commands.developers.login.sessionLoggedIn")
                    : status.status === "waiting_for_login"
                      ? ctx.t("commands.developers.login.sessionWaiting")
                      : status.status === "error"
                        ? ctx.t("commands.developers.login.sessionError", {
                              error: status.error ?? "unknown",
                          })
                        : ctx.t("commands.developers.login.sessionIdle");

            const lines = [
                `**${ctx.t("commands.developers.login.oauthField")}:** ${hasOauth ? ctx.t("commands.developers.login.statusActive") : ctx.t("commands.developers.login.statusMissing")}`,
                `**${ctx.t("commands.developers.login.cookieFileField")}:** ${hasCookies ? ctx.t("commands.developers.login.statusActive") : ctx.t("commands.developers.login.statusMissing")}`,
                `**${ctx.t("commands.developers.login.googleLoginField")}:** ${stateLabel}`,
                `**${ctx.t("commands.developers.login.lastRefreshLabel")}:** ${status.lastRefresh ? `<t:${Math.floor(status.lastRefresh / 1000)}:R>` : ctx.t("commands.developers.login.lastRefreshNever")}`,
                `**${ctx.t("commands.developers.login.gettingStartedField")}:** ${ctx.t("commands.developers.login.gettingStartedText", { loginCmd: `\`${ctx.prefix}login oauth\`` })}`,
            ].join("\n");

            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.developers.login.statusTitle"),
                    description: lines,
                }),
                true,
            );
            return;
        }

        if (sub === "logout") {
            await loginSvc.logout();
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.developers.login.logoutSuccess", { cmd: `\`${ctx.prefix}login start\`` })}`,
                }),
                true,
            );
            return;
        }

        if (sub === "oauth") {
            await ctx.defer(true);
            try {
                const session = await loginSvc.startOAuthDeviceLogin();
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        title: ctx.t("commands.developers.login.oauthStartedTitle"),
                        description: ctx.t("commands.developers.login.oauthStartedBody", {
                            url: session.verificationUrl,
                            code: session.userCode,
                            minutes: Math.max(1, Math.round(session.expiresIn / 60)),
                        }),
                    }),
                );
            } catch (err) {
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        title: ctx.t("commands.developers.login.loginError"),
                        description: ctx.t("commands.developers.login.loginErrorDescription", {
                            error: err instanceof Error ? err.message : String(err),
                        }),
                    }),
                );
            }
            return;
        }

        if (sub === "start") {
            const cur = await loginSvc.getStatus();
            if (cur.status === "logged_in" && cookieStore.hasCookies()) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: ctx.t("commands.developers.login.alreadyLoggedIn", {
                            logoutCmd: `\`${ctx.prefix}login logout\``,
                        }),
                    }),
                    true,
                );
                return;
            }

            await ctx.defer(true);
            try {
                const session = await loginSvc.startInteractiveLogin(300_000);
                const instructions = [
                    ctx.t("commands.developers.login.sessionDescription"),
                    ctx.t("commands.developers.login.step2Fallback", {
                        target: `127.0.0.1:${session.devtoolsPort}`,
                    }),
                    ctx.t("commands.developers.login.step3"),
                    ctx.t("commands.developers.login.timeLimit", { minutes: 5 }),
                ].join("\n");

                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        title: ctx.t("commands.developers.login.sessionTitle"),
                        description: instructions,
                    }),
                );
            } catch (err) {
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        title: ctx.t("commands.developers.login.loginError"),
                        description: ctx.t("commands.developers.login.loginErrorDescription", {
                            error: err instanceof Error ? err.message : String(err),
                        }),
                    }),
                );
            }
            return;
        }

        if (sub === "cookies") {
            const attachmentUrl = ctx.args.getAttachmentUrl("file");
            const inlineText = ctx.args.getString("text", 1, true);
            let rawCookies = inlineText?.trim() ?? "";

            if (attachmentUrl) {
                await ctx.defer(true);
                try {
                    const safeUrl = await assertSafePublicUrl(attachmentUrl);
                    const res = await fetch(safeUrl.toString(), {
                        signal: AbortSignal.timeout(10_000),
                    });
                    if (!res.ok) {
                        throw new Error(`HTTP ${res.status}`);
                    }
                    const text = await res.text();
                    if (text.length > 512_000) {
                        throw new Error("Cookie file exceeds 512 KB limit.");
                    }
                    rawCookies = text;
                } catch (err) {
                    await ctx.editReply(
                        buildNoticeContainer({
                            colorHex: botSettings.embedColor,
                            title: ctx.t("commands.developers.login.loginError"),
                            description: `${botSettings.noEmoji} ${
                                err instanceof Error ? err.message : String(err)
                            }`,
                        }),
                    );
                    return;
                }
            }

            if (!rawCookies) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.developers.login.cookiesMissingInput")}`,
                    }),
                    true,
                );
                return;
            }

            try {
                await loginSvc.importRawNetscapeCookies(rawCookies);
                if (ctx.message) {
                    void ctx.message.delete().catch(() => undefined);
                }
                const msgPayload = buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.yesEmoji} ${ctx.t("commands.developers.login.cookiesImported")}`,
                });
                if (attachmentUrl) {
                    await ctx.editReply(msgPayload);
                } else {
                    await ctx.reply(msgPayload, true);
                }
            } catch (err) {
                const errPayload = buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: ctx.t("commands.developers.login.loginError"),
                    description: `${botSettings.noEmoji} ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                });
                if (attachmentUrl) {
                    await ctx.editReply(errPayload);
                } else {
                    await ctx.reply(errPayload, true);
                }
            }
            return;
        }

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: ctx.t("commands.developers.login.invalidSubcommand", {
                    loginUsage: `\`${ctx.prefix}login <oauth | cookies | start | status | logout>\``,
                }),
            }),
            true,
        );
    },
};
