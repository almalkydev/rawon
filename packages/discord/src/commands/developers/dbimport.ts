import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
    type DatabaseExportBundle,
    fetchExportBundleFromUrl,
    importDatabaseBundle,
    importFromJsonFile,
    type MigrationImportCounts,
} from "@rawon/database";
import { SlashCommandBuilder } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const dbImportCommand: CommandDefinition = {
    name: "db-import",
    aliases: ["dbimport"],
    category: "developers",
    descriptionKey: "commands.developers.dbImport.description",
    usage: "commands.developers.dbImport.usage",
    cooldownMs: 5_000,
    guards: { devOnly: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("db-import")
            .setDescription(i18n.translate("commands.developers.dbImport.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.developers.dbImport.description", 100),
            )
            .addAttachmentOption((opt) =>
                opt
                    .setName("file")
                    .setDescription(
                        i18n.translate(
                            "commands.developers.dbImport.slashFileDescription",
                            "en-US",
                        ),
                    )
                    .setRequired(false),
            )
            .addStringOption((opt) =>
                opt
                    .setName("source")
                    .setDescription(
                        i18n.translate("commands.developers.dbImport.slashUrlDescription", "en-US"),
                    )
                    .setRequired(false),
            ),
    execute: async (ctx) => {
        const botSettings = await ctx.services.store.getBotSettings();
        await ctx.defer(true);

        const attachUrl =
            ctx.args.getAttachmentUrl("file") ?? ctx.message?.attachments.first()?.url ?? null;
        const sourceArg = ctx.args.getString("source", 0, true);

        try {
            let resultCounts: MigrationImportCounts;
            let bundleMeta: Pick<DatabaseExportBundle, "version" | "exportedAt"> = {
                version: "2.0.0",
                exportedAt: new Date().toISOString(),
            };

            if (attachUrl) {
                const bundle = await fetchExportBundleFromUrl(attachUrl);
                bundleMeta = { version: bundle.version, exportedAt: bundle.exportedAt };
                const res = await importDatabaseBundle(ctx.services.store, bundle, {
                    clearExisting: true,
                });
                resultCounts = res.counts;
            } else if (sourceArg && /^https?:\/\//iu.test(sourceArg)) {
                const bundle = await fetchExportBundleFromUrl(sourceArg);
                bundleMeta = { version: bundle.version, exportedAt: bundle.exportedAt };
                const res = await importDatabaseBundle(ctx.services.store, bundle, {
                    clearExisting: true,
                });
                resultCounts = res.counts;
            } else if (sourceArg) {
                // Confine local file imports strictly to configured dataDir (prevent path traversal)
                const safeName = basename(sourceArg);
                const fullPath = resolve(ctx.services.config.dataDir, safeName);
                if (!existsSync(fullPath)) {
                    await ctx.editReply(
                        buildNoticeContainer({
                            colorHex: botSettings.embedColor,
                            description: `${botSettings.noEmoji} ${ctx.t("commands.developers.dbImport.provideJsonHint")}`,
                        }),
                    );
                    return;
                }
                const res = await importFromJsonFile(ctx.services.store, fullPath, {
                    clearExisting: true,
                });
                resultCounts = res.counts;
            } else {
                await ctx.editReply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: `${botSettings.noEmoji} ${ctx.t("commands.developers.dbImport.provideJsonHint")}`,
                    }),
                );
                return;
            }

            const totalRecords = Object.values(resultCounts).reduce((a, b) => a + b, 0);
            ctx.services.sessions.refreshBotSettings(await ctx.services.store.getBotSettings());

            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    title: `${botSettings.yesEmoji} ${ctx.t("commands.developers.dbImport.success")}`,
                    description: [
                        `**${ctx.t("commands.developers.dbImport.totalRecords")}:** \`${totalRecords}\``,
                        `**${ctx.t("commands.developers.dbImport.version")}:** \`${bundleMeta.version}\``,
                        `**${ctx.t("commands.developers.dbImport.exportDate")}:** \`${bundleMeta.exportedAt}\``,
                    ].join("\n"),
                }),
            );
        } catch (err) {
            await ctx.editReply(
                buildNoticeContainer({
                    colorHex: botSettings.embedColor,
                    description: `${botSettings.noEmoji} ${ctx.t("commands.developers.dbImport.failed", { error: err instanceof Error ? err.message : String(err) })}`,
                }),
            );
        }
    },
};
