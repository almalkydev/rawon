# Discord Developer Portal & Permission Requirements

Rawon V2 strictly uses official supported Discord Gateway Intents, Interaction APIs, and Components V2 without attempting to bypass privileged intent restrictions.

## Required Gateway Intents

In `packages/discord/src/MultiBotSupervisor.ts`, each bot client registers the following Gateway Intents:

| Intent | Discord Privilege | Required For |
|---|---|---|
| `GatewayIntentBits.Guilds` | Standard | Guild discovery, channel resolution, voice channel tracking, cleanup on guild removal |
| `GatewayIntentBits.GuildVoiceStates` | Standard | Detecting user voice channel membership, bot voice state, auto-pause/leave on empty VC |
| `GatewayIntentBits.GuildMessages` | Standard | Receiving messages in guilds |
| `GatewayIntentBits.MessageContent` | **Privileged** | **Hydra `#request` channel song detection**, prefix commands (`ENABLE_PREFIX=true`), message-mode search selection (`1..10`) |

### Enabling `Message Content Intent` in Discord Developer Portal

For every bot token configured in `DISCORD_TOKEN`:

1. Open [Discord Developer Portal](https://discord.com/developers/applications) and select the application.
2. Go to **Bot** -> **Privileged Gateway Intents**.
3. Enable **Message Content Intent**.
4. Save changes and restart the bot.

> [!NOTE]
> If your deployment operates exclusively via `/slash` commands with no prefix commands and no Request Channel text parsing, disabling `MessageContent` prevents the Hydra request channel and prefix parser from reading message content. Always keep **Message Content Intent** enabled for full feature parity.

## Required Bot Invite Permissions

When generating an invite URL (or using `/invite`):

- **Scopes**: `bot`, `applications.commands`
- **Channel / Messaging Permissions**:
  - `View Channel`
  - `Send Messages`
  - `Embed Links` (for fallback/legacy link unfurling where needed)
  - `Attach Files` (used by `/db-export`)
  - `Read Message History`
  - `Manage Messages` (required in Hydra `#request` channels to delete processed user request messages cleanly)
- **Voice Permissions**:
  - `Connect`
  - `Speak`
  - `Use Voice Activity`
  - `Request to Speak` / `Mute Members` (if operating in Stage Channels; Rawon V2 automatically requests Stage speaker status where supported)
  - Voice Channel Status updates use `PUT /channels/{id}/voice-status` when permitted.
