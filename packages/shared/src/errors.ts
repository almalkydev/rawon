export type ErrorCategory =
    | "validation"
    | "permission"
    | "unavailable"
    | "expired_stream"
    | "bot_detection"
    | "age_restricted"
    | "rate_limit"
    | "network"
    | "security"
    | "audio"
    | "database"
    | "internal";

export interface RawonErrorOptions {
    category: ErrorCategory;
    retryable?: boolean;
    cause?: unknown;
    metadata?: Record<string, unknown>;
}

export class RawonError extends Error {
    public readonly category: ErrorCategory;
    public readonly retryable: boolean;
    public readonly metadata?: Record<string, unknown>;

    public constructor(message: string, options: RawonErrorOptions) {
        super(message, { cause: options.cause });
        this.name = new.target.name;
        this.category = options.category;
        this.retryable = options.retryable ?? false;
        this.metadata = options.metadata;
    }
}

export class ProviderError extends RawonError {
    public constructor(
        message: string,
        category: ErrorCategory = "unavailable",
        retryable = false,
        cause?: unknown,
        metadata?: Record<string, unknown>,
    ) {
        super(message, { category, retryable, cause, metadata });
    }
}

export class ExpiredStreamError extends RawonError {
    public constructor(
        message: string,
        public readonly statusCode?: number,
        cause?: unknown,
    ) {
        super(message, {
            category: "expired_stream",
            retryable: true,
            cause,
            metadata: statusCode !== undefined ? { statusCode } : undefined,
        });
    }
}

export class SecurityError extends RawonError {
    public constructor(message: string, cause?: unknown) {
        super(message, { category: "security", retryable: false, cause });
    }
}

export class RateLimitError extends RawonError {
    public constructor(
        message: string,
        public readonly retryAfterMs: number,
    ) {
        super(message, {
            category: "rate_limit",
            retryable: true,
            metadata: { retryAfterMs },
        });
    }
}

export class ValidationError extends RawonError {
    public constructor(message: string) {
        super(message, { category: "validation", retryable: false });
    }
}

export class AudioEngineError extends RawonError {
    public constructor(message: string, retryable = true, cause?: unknown) {
        super(message, { category: "audio", retryable, cause });
    }
}
