import { loadConfig, loadEnvFiles } from "@rawon/config";
import { createLogger } from "@rawon/shared";
import { importFromJsonFile, importFromLegacySqlite } from "./MigrationBridge.js";
import { PostgresDatabaseStore } from "./PostgresStore.js";

async function main(): Promise<void> {
    loadEnvFiles();
    const config = loadConfig();
    const logger = createLogger({
        scope: "rawon-migrate",
        level: config.debugMode ? "debug" : "info",
    });

    if (!config.databaseUrl) {
        logger.error("DATABASE_URL must be configured to run migrations.");
        process.exit(1);
    }

    const args = process.argv.slice(2);
    const subcommand = args[0] ?? "migrate";

    const store = new PostgresDatabaseStore({
        connectionString: config.databaseUrl,
        maxConnections: 5,
        logger,
    });

    try {
        await store.initialize();

        if (subcommand === "migrate" || subcommand === "up") {
            logger.info("PostgreSQL schema migrations are up to date.");
            return;
        }

        if (subcommand === "import-sqlite" || subcommand === "import-legacy") {
            const filePath = args[1];
            if (!filePath) {
                logger.error("Usage: migrate-cli import-sqlite <path-to-data.db>");
                process.exit(1);
            }
            const res = await importFromLegacySqlite(store, filePath, { clearExisting: true });
            logger.info(
                { counts: res.counts, warnings: res.warnings },
                "Legacy SQLite import complete.",
            );
            return;
        }

        if (subcommand === "import-json") {
            const filePath = args[1];
            if (!filePath) {
                logger.error("Usage: migrate-cli import-json <path-to-export.json>");
                process.exit(1);
            }
            const res = await importFromJsonFile(store, filePath, { clearExisting: true });
            logger.info({ counts: res.counts }, "JSON export bundle import complete.");
            return;
        }

        logger.error(
            { subcommand },
            "Unknown migrate-cli command. Use: migrate | import-sqlite <file> | import-json <file>",
        );
        process.exit(1);
    } finally {
        await store.close();
    }
}

main().catch((err) => {
    console.error("Migration CLI failed:", err);
    process.exit(1);
});
