import { SlashCommandBuilder } from "discord.js";
import { buildQueuePagePayload } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";

export const queueCommand: CommandDefinition = {
    name: "queue",
    aliases: ["q", "list"],
    category: "music",
    descriptionKey: "commands.music.queue.description",
    cooldownMs: 3_000,
    guards: { guildOnly: true, requireActiveSession: true },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("queue")
            .setDescription(i18n.translate("commands.music.queue.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.queue.description", 100),
            )
            .addIntegerOption((opt) =>
                opt.setName("page").setDescription("Page number").setMinValue(1).setRequired(false),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const page = ctx.args.getInteger("page", 0) ?? 1;

        await ctx.reply(
            buildQueuePagePayload({
                tracks: ctx.activeSession.queue.getAll(),
                currentKey: ctx.activeSession.queue.currentKey,
                page,
                botSettings,
                t: ctx.t,
                guildId: ctx.guild.id,
                botId: ctx.activeSession.botId,
            }),
        );
    },
};
