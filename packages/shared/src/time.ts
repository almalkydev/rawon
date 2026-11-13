export function normalizeTime(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "0:00";
    }
    const whole = Math.floor(seconds);
    const hrs = Math.floor(whole / 3600);
    const mins = Math.floor((whole % 3600) / 60);
    const secs = whole % 60;

    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function parseTime(input: string): number | null {
    const trimmed = input.trim();
    if (!trimmed) {
        return null;
    }

    if (/^\d+(?:\.\d+)?$/u.test(trimmed)) {
        const secs = Math.floor(Number(trimmed));
        return Number.isFinite(secs) && secs >= 0 ? secs : null;
    }

    if (trimmed.includes(":")) {
        const parts = trimmed.split(":");
        if (parts.length < 2 || parts.length > 3) {
            return null;
        }
        let total = 0;
        for (const part of parts) {
            if (!/^\d+$/u.test(part)) {
                return null;
            }
            const value = Number.parseInt(part, 10);
            if (!Number.isFinite(value) || value < 0) {
                return null;
            }
            total = total * 60 + value;
        }
        return total;
    }

    // Support verbose human format like "1h2m30s" or "90s"
    const unitMatch = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/iu.exec(trimmed);
    if (unitMatch && (unitMatch[1] || unitMatch[2] || unitMatch[3])) {
        const h = Number(unitMatch[1] ?? 0);
        const m = Number(unitMatch[2] ?? 0);
        const s = Number(unitMatch[3] ?? 0);
        return h * 3600 + m * 60 + s;
    }

    return null;
}

export function formatDurationMs(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
        return "0s";
    }
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${seconds}s`);
    return parts.join(" ");
}
