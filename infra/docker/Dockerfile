# Rawon V2 — Multi-Stage Production Dockerfile
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@8.15.9 --activate

FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/cache/package.json packages/cache/package.json
COPY packages/providers/package.json packages/providers/package.json
COPY packages/audio-engine/package.json packages/audio-engine/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/music-core/package.json packages/music-core/package.json
COPY packages/discord/package.json packages/discord/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY apps/worker/package.json apps/worker/package.json

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY packages ./packages
COPY apps ./apps
RUN pnpm build \
    && CI=true pnpm prune --prod --ignore-scripts \
    && rm -rf packages/*/src apps/*/src packages/*/tsconfig.json apps/*/tsconfig.json

FROM node:24-bookworm-slim AS runtime
ARG INSTALL_CHROMIUM=false
ENV NODE_ENV=production
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV YT_DLP_PATH=/usr/local/bin/yt-dlp
ENV CACHE_DIR=/app/cache
ENV XDG_CACHE_HOME=/app/cache/xdg
ENV DATA_DIR=/app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    python3 \
    && if [ "$INSTALL_CHROMIUM" = "true" ]; then \
         apt-get install -y --no-install-recommends chromium; \
       fi \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && apt-get purge -y --auto-remove curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 10001 rawon \
    && useradd --uid 10001 --gid rawon --create-home --shell /usr/sbin/nologin rawon

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/apps ./apps
COPY LICENSE NOTICE ./

RUN mkdir -p /app/cache /app/cache/xdg /app/data && chown -R rawon:rawon /app

USER rawon

EXPOSE 9090 9091

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.METRICS_PORT || 9090) + '/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "apps/bot/dist/index.js"]
