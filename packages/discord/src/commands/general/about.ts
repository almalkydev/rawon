import { uptime as osUptime, release } from "node:os";
import { normalizeTime } from "@rawon/shared";
import { version as djsVersion, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const aboutCommand: CommandDefinition = {
    name: "about",
    aliases: ["ab", "info"],
    category: "general",
    descriptionKey: "commands.general.about.description",
    cooldownMs: 3_000,
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("about")
            .setDescription(i18n.translate("commands.general.about.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.general.about.description", 100),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        const ffmpegPath = ctx.services.audioPipeline.getFfmpegExecutable();
        const totalGuilds = ctx.services
            .getBotRuntimes()
            .reduce((acc, r) => acc + r.client.guilds.cache.size, 0);
        const totalChannels = ctx.services
            .getBotRuntimes()
            .reduce((acc, r) => acc + r.client.channels.cache.size, 0);
        const totalUsers = ctx.services
            .getBotRuntimes()
            .reduce((acc, r) => acc + r.client.users.cache.size, 0);
        const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);

        const lines = [
            `**${ctx.t("commands.general.about.serversString")}:** \`${totalGuilds}\``,
            `**${ctx.t("commands.general.about.channelsString")}:** \`${totalChannels}\``,
            `**${ctx.t("commands.general.about.cachedUsersString")}:** \`${totalUsers}\``,
            `**${ctx.t("commands.general.about.botVersionString")}:** \`Rawon v2.0.0\``,
            `**${ctx.t("commands.general.about.discordJSVersionString")}:** \`discord.js v${djsVersion}\``,
            `**${ctx.t("commands.general.about.nodeVersionString")}:** \`Node.js ${process.version}\``,
            `**${ctx.t("commands.general.about.ffmpegVersionString")}:** \`${ffmpegPath}\``,
            `**${ctx.t("commands.general.about.botUptimeString")}:** \`${normalizeTime(Math.floor(ctx.runtime.getUptimeMs() / 1000))}\``,
            `**${ctx.t("commands.general.about.processUptimeString")}:** \`${normalizeTime(Math.floor(process.uptime()))}\``,
            `**${ctx.t("commands.general.about.osUptimeString")}:** \`${normalizeTime(Math.floor(osUptime()))} (${release()})\``,
            `**RSS Memory:** \`${memMb} MB\``,
            `**${ctx.t("commands.general.about.sourceCodeString")}:** [GitHub (stegripe/rawon)](https://github.com/stegripe/rawon)`,
        ].join("\n");

        const payload = buildNoticeContainer({
            colorHex: botSettings.embedColor,
            title: ctx.t("commands.general.about.aboutFooter", {
                botname: ctx.client.user?.username ?? "Rawon",
            }),
            description: lines,
        });
        await ctx.reply(payload);
    },
};
