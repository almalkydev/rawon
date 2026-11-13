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
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const sub = (ctx.args.getSubcommand(0) ?? "status").toLowerCase();
        const loginSvc = ctx.services.getOrCreateGoogleLoginService();
        const cookieStore = ctx.services.getCookieStore();

        if (sub === "status") {
            const status = await loginSvc.getStatus();
            const hasCookies = cookieStore.hasCookies();
            const stateLabel =
                status.status === "logged_in"
                    ? ctx.t("commands.developers.login.sessionLoggedIn")
                    : status.status === "waiting_for_login"
                      ? ctx.t("commands.developers.login.sessionWaiting")
                      : status.status === "error"
                        ? ctx.t("commands.developers.login.sessionError", {
                              error: status.error ?? "unknown",
                          })
                        : ctx.t("commands.developers.login.sessionIdle");

            const lines = [
                `**${ctx.t("commands.developers.login.cookieFileField")}:** ${hasCookies ? ctx.t("commands.developers.login.statusActive") : ctx.t("commands.developers.login.statusMissing")}`,
                `**${ctx.t("commands.developers.login.googleLoginField")}:** ${stateLabel}`,
                `**${ctx.t("commands.developers.login.lastRefreshLabel")}:** ${status.lastRefresh ? `<t:${Math.floor(status.lastRefresh / 1000)}:R>` : ctx.t("commands.developers.login.lastRefreshNever")}`,
                `**${ctx.t("commands.developers.login.gettingStartedField")}:** ${ctx.t("commands.developers.login.gettingStartedText", { loginCmd: `\`${ctx.prefix}login start\`` })}`,
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

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: ctx.t("commands.developers.login.invalidSubcommand", {
                    loginUsage: `\`${ctx.prefix}login <start | status | logout>\``,
                }),
            }),
            true,
        );
    },
};
