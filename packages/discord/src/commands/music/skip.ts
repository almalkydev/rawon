import { SlashCommandBuilder, type VoiceBasedChannel } from "discord.js";
import { buildNoticeContainer } from "../../playerUi.js";
import type { CommandDefinition } from "../../types.js";
import { canControlPlayback, countHumanVoiceMembers } from "../../utils/guards.js";

const skipVotes = new Map<string, { trackKey: string; voters: Set<string> }>();

export const skipCommand: CommandDefinition = {
    name: "skip",
    aliases: ["s", "next"],
    category: "music",
    descriptionKey: "commands.music.skip.description",
    cooldownMs: 1_500,
    guards: {
        guildOnly: true,
        inVoiceChannel: true,
        sameVoiceChannel: true,
        requireActiveSession: true,
        requireCurrentTrack: true,
    },
    buildSlash: (i18n) =>
        new SlashCommandBuilder()
            .setName("skip")
            .setDescription(i18n.translate("commands.music.skip.description", "en-US"))
            .setDescriptionLocalizations(
                i18n.getDiscordLocalizations("commands.music.skip.description", 100),
            ),
    execute: async (ctx) => {
        if (!ctx.guild || !ctx.member || !ctx.activeSession) return;
        const botSettings = await ctx.services.store.getBotSettings();
        const guildConfig = await ctx.services.store.getGuildConfig(ctx.guild.id);
        const current = ctx.activeSession.currentTrack;
        if (!current) return;

        const vc = ctx.member.voice.channel as VoiceBasedChannel | null;
        const humans = vc ? countHumanVoiceMembers(vc) : 1;
        const privileged = canControlPlayback({
            member: ctx.member,
            guildConfig,
            currentRequesterId: current.requesterId,
            devs: ctx.services.config.devs,
        });

        if (!privileged && humans >= 3) {
            const voteKey = `${ctx.guild.id}:${ctx.activeSession.botId}`;
            let entry = skipVotes.get(voteKey);
            if (!entry || entry.trackKey !== current.key) {
                entry = { trackKey: current.key, voters: new Set() };
                skipVotes.set(voteKey, entry);
            }
            entry.voters.add(ctx.userId);
            const required = Math.ceil(humans / 2);
            if (entry.voters.size < required) {
                await ctx.reply(
                    buildNoticeContainer({
                        colorHex: botSettings.embedColor,
                        description: ctx.t("commands.music.skip.voteResultMessage", {
                            length: entry.voters.size,
                            required,
                        }),
                    }),
                );
                return;
            }
        }

        skipVotes.delete(`${ctx.guild.id}:${ctx.activeSession.botId}`);
        const { skipped } = await ctx.activeSession.skip();
        await ctx.services.syncRequestChannelPlayer(ctx.guild.id, ctx.activeSession.botId);

        await ctx.reply(
            buildNoticeContainer({
                colorHex: botSettings.embedColor,
                description: `${botSettings.yesEmoji} ${ctx.t("commands.music.skip.skipMessage", {
                    song: skipped ? `**[${skipped.track.title}](${skipped.track.url})**` : "",
                })}`,
            }),
        );
    },
};
