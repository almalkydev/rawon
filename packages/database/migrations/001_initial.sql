CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guilds (
    guild_id TEXT PRIMARY KEY,
    prefix TEXT,
    locale TEXT,
    dj_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    dj_role_id TEXT,
    max_queue_size INTEGER NOT NULL DEFAULT 500,
    rc_rate_limit_max INTEGER NOT NULL DEFAULT 5,
    rc_rate_limit_window_ms INTEGER NOT NULL DEFAULT 15000,
    rc_exclusions_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS request_channels (
    guild_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_request_channels_channel ON request_channels (guild_id, channel_id);

CREATE TABLE IF NOT EXISTS player_states (
    guild_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    loop_mode TEXT NOT NULL DEFAULT 'OFF',
    shuffle BOOLEAN NOT NULL DEFAULT FALSE,
    autoplay BOOLEAN NOT NULL DEFAULT FALSE,
    volume INTEGER NOT NULL DEFAULT 100,
    quality_profile TEXT NOT NULL DEFAULT 'fidelity',
    normalize_audio BOOLEAN NOT NULL DEFAULT FALSE,
    filters_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    equalizer_json JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, bot_id)
);

CREATE TABLE IF NOT EXISTS queue_sessions (
    guild_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    voice_channel_id TEXT NOT NULL,
    text_channel_id TEXT NOT NULL,
    current_track_key TEXT,
    position_ms BIGINT NOT NULL DEFAULT 0,
    paused BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, bot_id)
);

CREATE TABLE IF NOT EXISTS queue_tracks (
    guild_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    track_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    track_json JSONB NOT NULL,
    requester_id TEXT NOT NULL,
    requester_tag TEXT,
    added_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, bot_id, track_key)
);

CREATE INDEX IF NOT EXISTS idx_queue_tracks_order ON queue_tracks (guild_id, bot_id, position);

CREATE TABLE IF NOT EXISTS voice_channel_status_states (
    guild_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    status_set BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (guild_id, bot_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'google_youtube',
    status TEXT NOT NULL DEFAULT 'idle',
    email TEXT,
    visitor_data TEXT,
    cookie_hash TEXT,
    last_refresh BIGINT,
    error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
