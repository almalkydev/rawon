import type { I18nService } from "@rawon/config";
import { ApplicationCommandType, ContextMenuCommandBuilder } from "discord.js";
import { dbExportCommand } from "./commands/developers/dbexport.js";
import { dbImportCommand } from "./commands/developers/dbimport.js";
import { evalCommand } from "./commands/developers/eval.js";
import { loginCommand } from "./commands/developers/login.js";
import { setupCommand } from "./commands/developers/setup.js";
import { aboutCommand } from "./commands/general/about.js";
import { helpCommand } from "./commands/general/help.js";
import { inviteCommand } from "./commands/general/invite.js";
import { languageCommand } from "./commands/general/language.js";
import { pingCommand } from "./commands/general/ping.js";
import { prefixCommand } from "./commands/general/prefix.js";
import { setRegisteredCommands } from "./commands/helpers.js";
import { autoplayCommand } from "./commands/music/autoplay.js";
import { djCommand } from "./commands/music/dj.js";
import { filterCommand } from "./commands/music/filter.js";
import { lyricsCommand } from "./commands/music/lyrics.js";
import { nowPlayingCommand } from "./commands/music/nowplaying.js";
import { pauseCommand } from "./commands/music/pause.js";
import { playCommand } from "./commands/music/play.js";
import { previousCommand } from "./commands/music/previous.js";
import { queueCommand } from "./commands/music/queue.js";
import { removeCommand } from "./commands/music/remove.js";
import { repeatCommand } from "./commands/music/repeat.js";
import { requestChannelCommand } from "./commands/music/requestchannel.js";
import { resumeCommand } from "./commands/music/resume.js";
import { searchCommand } from "./commands/music/search.js";
import { seekCommand } from "./commands/music/seek.js";
import { shuffleCommand } from "./commands/music/shuffle.js";
import { skipCommand } from "./commands/music/skip.js";
import { skipToCommand } from "./commands/music/skipto.js";
import { stopCommand } from "./commands/music/stop.js";
import { volumeCommand } from "./commands/music/volume.js";
import type { CommandDefinition } from "./types.js";

export const ALL_COMMANDS: readonly CommandDefinition[] = [
    // Developers
    dbExportCommand,
    dbImportCommand,
    evalCommand,
    loginCommand,
    setupCommand,
    // General
    aboutCommand,
    helpCommand,
    inviteCommand,
    languageCommand,
    pingCommand,
    prefixCommand,
    // Music
    autoplayCommand,
    djCommand,
    filterCommand,
    lyricsCommand,
    nowPlayingCommand,
    pauseCommand,
    playCommand,
    previousCommand,
    queueCommand,
    removeCommand,
    repeatCommand,
    requestChannelCommand,
    resumeCommand,
    searchCommand,
    seekCommand,
    shuffleCommand,
    skipCommand,
    skipToCommand,
    stopCommand,
    volumeCommand,
];

setRegisteredCommands(ALL_COMMANDS);

export class CommandRegistry {
    private readonly byName = new Map<string, CommandDefinition>();
    private readonly byAlias = new Map<string, CommandDefinition>();

    public constructor(commands: readonly CommandDefinition[] = ALL_COMMANDS) {
        for (const cmd of commands) {
            const nameLower = cmd.name.toLowerCase();
            this.byName.set(nameLower, cmd);
            this.byAlias.set(nameLower, cmd);
            for (const alias of cmd.aliases ?? []) {
                this.byAlias.set(alias.toLowerCase(), cmd);
            }
        }
    }

    public getByName(name: string): CommandDefinition | undefined {
        return this.byName.get(name.toLowerCase());
    }

    public resolveCommand(nameOrAlias: string): CommandDefinition | undefined {
        return this.byAlias.get(nameOrAlias.toLowerCase());
    }

    public listAll(): readonly CommandDefinition[] {
        return Array.from(this.byName.values());
    }

    public buildApplicationCommandsJson(i18n: I18nService): unknown[] {
        const slashJson = this.listAll().map((cmd) => {
            const builder = cmd.buildSlash(i18n);
            return "toJSON" in builder && typeof builder.toJSON === "function"
                ? builder.toJSON()
                : builder;
        });

        const contextMenu = new ContextMenuCommandBuilder()
            .setName("Play with Rawon")
            .setType(ApplicationCommandType.Message)
            .toJSON();

        return [...slashJson, contextMenu];
    }
}
