import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const pingCommand: CommandDefinition = {
    name: "ping",
    aliases: ["latency", "pong"],
    category: "general",
    descriptionKey: "commands.general.ping.description",
    cooldownMs: 3_000,
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("ping")
            .setDescription(i18n.translate("commands.general.ping.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.ping.description", 100),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const t0 = performance.now();
        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: "🏓 Pinging...",
            }),
        );
        const rtt = Math.round(performance.now() - t0);
        const wsPing = Math.max(0, Math.round(ctx.client.ws.ping));
        const activeCount = ctx.services.sessions.getActiveCount();

        const desc = [
            `🏓 **API Latency:** \`${rtt}ms\``,
            `📡 **WebSocket Ping:** \`${wsPing}ms\``,
            `🎧 **Active Voice Sessions:** \`${activeCount}\``,
            `-# ${ctx.t("commands.general.ping.footerString", { user: ctx.userTag })}`,
        ].join("\n");

        await ctx.editReply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: desc,
            }),
        );
    },
};
