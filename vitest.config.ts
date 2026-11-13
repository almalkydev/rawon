import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
    resolve: {
        alias: {
            "@rawon/shared": resolve(import.meta.dirname, "packages/shared/src/index.ts"),
            "@rawon/config": resolve(import.meta.dirname, "packages/config/src/index.ts"),
            "@rawon/queue": resolve(import.meta.dirname, "packages/queue/src/index.ts"),
            "@rawon/cache": resolve(import.meta.dirname, "packages/cache/src/index.ts"),
            "@rawon/providers": resolve(import.meta.dirname, "packages/providers/src/index.ts"),
            "@rawon/audio-engine": resolve(import.meta.dirname, "packages/audio-engine/src/index.ts"),
            "@rawon/database": resolve(import.meta.dirname, "packages/database/src/index.ts"),
            "@rawon/music-core": resolve(import.meta.dirname, "packages/music-core/src/index.ts"),
            "@rawon/discord": resolve(import.meta.dirname, "packages/discord/src/index.ts"),
        },
    },
    test: {
        globals: false,
        environment: "node",
        testTimeout: 30_000,
        hookTimeout: 30_000,
        include: ["tests/**/*.test.ts"],
    },
});
