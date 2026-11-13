import type { CommandDefinition } from "../types.js";

let registeredCommandsCache: readonly CommandDefinition[] = [];

export function setRegisteredCommands(cmds: readonly CommandDefinition[]): void {
    registeredCommandsCache = cmds;
}

export function getRegisteredCommands(): readonly CommandDefinition[] {
    return registeredCommandsCache;
}
