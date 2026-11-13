import pino from "pino";

export type Logger = pino.Logger;

export interface CreateLoggerOptions {
    scope: string;
    level?: string;
    pretty?: boolean;
    redactSecrets?: string[];
}

export function createLogger(options: CreateLoggerOptions): Logger {
    const pretty = options.pretty ?? process.env.NODE_ENV !== "production";
    const level = options.level ?? (process.env.DEBUG_MODE === "yes" ? "debug" : "info");

    return pino({
        name: options.scope,
        level,
        redact: {
            paths: [
                "token",
                "password",
                "authorization",
                "headers.authorization",
                "headers.Authorization",
                "clientSecret",
                "databaseUrl",
                "redisUrl",
                "cookie",
                "cookies",
            ],
            censor: "[REDACTED]",
        },
        formatters: {
            level: (label) => ({ level: label }),
            bindings: () => ({ pid: process.pid, scope: options.scope }),
        },
        ...(pretty
            ? {
                  transport: {
                      target: "pino-pretty",
                      options: {
                          colorize: true,
                          translateTime: "SYS:yyyy-MM-dd HH:mm:ss",
                          ignore: "pid,hostname",
                      },
                  },
              }
            : {}),
    });
}

export function redactSensitiveText(text: string, secrets: readonly string[]): string {
    let result = text;
    for (const secret of secrets) {
        if (secret && secret.length >= 6) {
            result = result.replaceAll(secret, "[REDACTED]");
        }
    }
    return result;
}
