import { inspect } from "node:util";
import { chunkText, redactSensitiveText } from "@rawon/shared";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
) => (...params: unknown[]) => Promise<unknown>;

export const evalCommand: CommandDefinition = {
    name: "eval",
    aliases: ["ev"],
    category: "developers",
    descriptionKey: "commands.developers.eval.description",
    usage: "commands.developers.eval.usage",
    cooldownMs: 1_000,
    guards: { devOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("eval")
            .setDescription(i18n.translate("commands.developers.eval.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.developers.eval.description", 100),
            )
            .addStringOption((opt) =>
                opt.setName("code").setDescription("JavaScript expression/block").setRequired(true),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const codeRaw = ctx.args.getString("code", 0, true);
        if (!codeRaw) {
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.developers.eval.noCode")}`,
                }),
                true,
            );
            return;
        }

        const secrets = [
            ...ctx.services.config.discordTokens,
            ctx.services.config.databaseUrl,
            ctx.services.config.redisUrl,
            ctx.services.config.stegripeApiLyricsToken,
            ctx.services.config.spotifyClientSecret,
            ctx.services.config.cookiesEncryptionKey ?? "",
        ].filter(Boolean);

        const body =
            codeRaw.includes("\n") || codeRaw.includes("return ")
                ? codeRaw
                : `return (${codeRaw});`;

        try {
            const fn = new AsyncFunction("ctx", "client", "services", body);
            const result = await fn(ctx, ctx.client, ctx.services);
            const formatted = typeof result === "string" ? result : inspect(result, { depth: 2 });
            const clean = redactSensitiveText(formatted, secrets);
            const snippet = chunkText(clean, 1900)[0] ?? "undefined";

            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: [
                        `**${ctx.t("commands.developers.eval.inputString")}:**`,
                        `\`\`\`js\n${codeRaw.slice(0, 600)}\n\`\`\``,
                        `**${ctx.t("commands.developers.eval.outputString")}:**`,
                        `\`\`\`js\n${snippet}\n\`\`\``,
                    ].join("\n"),
                }),
                true,
            );
        } catch (err) {
            const msg = redactSensitiveText(
                err instanceof Error ? (err.stack ?? err.message) : String(err),
                secrets,
            );
            await ctx.reply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: [
                        `**${ctx.t("commands.developers.eval.errorString")}:**`,
                        `\`\`\`js\n${msg.slice(0, 1900)}\n\`\`\``,
                    ].join("\n"),
                }),
                true,
            );
        }
    },
};
