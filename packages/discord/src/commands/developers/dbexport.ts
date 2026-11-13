import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportDatabaseBundle } from "@rawon/database";
import { AttachmentBuilder, SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const dbExportCommand: CommandDefinition = {
    name: "db-export",
    aliases: ["dbexport"],
    category: "developers",
    descriptionKey: "commands.developers.dbExport.description",
    cooldownMs: 5_000,
    guards: { devOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("db-export")
            .setDescription(i18n.translate("commands.developers.dbExport.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.developers.dbExport.description", 100),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        await ctx.defer(true);
        try {
            const bundle = await exportDatabaseBundle(ctx.services.store);
            const jsonText = JSON.stringify(bundle, null, 2);
            const totalRecords =
                bundle.data.guilds.length +
                bundle.data.request_channels.length +
                bundle.data.player_states.length +
                bundle.data.queue_states.length +
                bundle.data.voice_channel_status_states.length +
                bundle.data.cookies_state.length +
                bundle.data.bot_settings.length;

            mkdirSync(ctx.services.config.dataDir, { recursive: true });
            const filename = `rawon-export-${Date.now()}.json`;
            const filePath = join(ctx.services.config.dataDir, filename);
            writeFileSync(filePath, jsonText, "utf8");

            const attachment = new AttachmentBuilder(Buffer.from(jsonText, "utf8"), {
                name: filename,
            });
            const notice = buildNoticeContainer({
                colorHex: botSettings.embedColor,
                title: `${botSettings.yesEmoji} ${ctx.t("commands.developers.dbExport.success")}`,
                description: [
                    `**${ctx.t("commands.developers.dbExport.totalRecords")}:** \`${totalRecords}\``,
                    ctx.t("commands.developers.dbExport.savedTo", { path: filePath }),
                ].join("\n"),
            });

            if (ctx.interaction) {
                await ctx.interaction.editReply({
                    ...notice,
                    files: [attachment],
                } as never);
            } else if (ctx.channel && "send" in ctx.channel) {
                await ctx.channel.send({
                    ...notice,
                    files: [attachment],
                } as never);
            }
        } catch (err) {
            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.developers.dbExport.failed", { error: err instanceof Error ? err.message : String(err) })}`,
                }),
            );
        }
    },
};
