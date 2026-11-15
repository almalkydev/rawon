import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface NetscapeCookieEntry {
    domain: string;
    includeSubdomains: boolean;
    path: string;
    secure: boolean;
    expiration: number;
    name: string;
    value: string;
    httpOnly?: boolean;
}

export class CookieStore {
    public readonly cookiesTxtPath: string;
    private readonly encryptedPath: string;
    private readonly secretKey: Buffer | null;

    public constructor(options: { dataDir: string; encryptionKey?: string | null }) {
        this.cookiesTxtPath = join(options.dataDir, "cookies.txt");
        this.encryptedPath = join(options.dataDir, "cookies.enc");
        this.secretKey = options.encryptionKey
            ? scryptSync(options.encryptionKey, "rawon-cookie-salt-v2", 32)
            : null;

        if (!existsSync(options.dataDir)) {
            mkdirSync(options.dataDir, { recursive: true });
        }
    }

    public saveCookies(entries: NetscapeCookieEntry[]): {
        cookiesPath: string;
        cookieHash: string;
        count: number;
    } {
        const defaultExpiry = Math.floor(Date.now() / 1000) + 86400 * 365;
        const lines = [
            "# Netscape HTTP Cookie File",
            "# Exported by Rawon V2 CookieStore",
            ...entries.map((c) => {
                const rawDomain = c.domain.replace(/^#HttpOnly_/u, "").trim();
                const isYouTubeOrGoogleRoot =
                    rawDomain === "youtube.com" || rawDomain === "google.com";
                const normalizedDomain =
                    rawDomain.startsWith(".") || (!c.includeSubdomains && !isYouTubeOrGoogleRoot)
                        ? rawDomain
                        : `.${rawDomain}`;
                const includeSubdomains = normalizedDomain.startsWith(".");
                const domainField = c.httpOnly ? `#HttpOnly_${normalizedDomain}` : normalizedDomain;
                const expiration =
                    Number.isFinite(c.expiration) && c.expiration > 0
                        ? Math.floor(c.expiration)
                        : defaultExpiry;
                return [
                    domainField,
                    includeSubdomains ? "TRUE" : "FALSE",
                    c.path || "/",
                    c.secure ? "TRUE" : "FALSE",
                    expiration,
                    c.name,
                    c.value,
                ].join("\t");
            }),
        ];
        const content = `${lines.join("\n")}\n`;
        const cookieHash = createHash("sha256").update(content).digest("hex");

        mkdirSync(dirname(this.cookiesTxtPath), { recursive: true });
        // Always maintain yt-dlp readable cookies.txt (0600 permissions)
        writeFileSync(this.cookiesTxtPath, content, { encoding: "utf8", mode: 0o600 });

        if (this.secretKey) {
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", this.secretKey, iv);
            const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            const payload = Buffer.concat([iv, tag, encrypted]);
            writeFileSync(this.encryptedPath, payload, { mode: 0o600 });
        }

        return {
            cookiesPath: this.cookiesTxtPath,
            cookieHash,
            count: entries.length,
        };
    }

    public restoreFromEncryptedIfNeeded(): string | null {
        if (existsSync(this.cookiesTxtPath)) {
            return this.cookiesTxtPath;
        }
        if (!this.secretKey || !existsSync(this.encryptedPath)) {
            return null;
        }
        try {
            const buf = readFileSync(this.encryptedPath);
            if (buf.byteLength < 29) return null;
            const iv = buf.subarray(0, 12);
            const tag = buf.subarray(12, 28);
            const ciphertext = buf.subarray(28);
            const decipher = createDecipheriv("aes-256-gcm", this.secretKey, iv);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
                "utf8",
            );
            writeFileSync(this.cookiesTxtPath, plain, { encoding: "utf8", mode: 0o600 });
            return this.cookiesTxtPath;
        } catch {
            return null;
        }
    }

    public hasCookies(): boolean {
        return existsSync(this.cookiesTxtPath) || existsSync(this.encryptedPath);
    }

    public clear(): void {
        if (existsSync(this.cookiesTxtPath)) unlinkSync(this.cookiesTxtPath);
        if (existsSync(this.encryptedPath)) unlinkSync(this.encryptedPath);
    }
}

function stripBom(text: string): string {
    return text.replace(/^\uFEFF/u, "");
}

function parseNetscapeLines(text: string): NetscapeCookieEntry[] {
    const entries: NetscapeCookieEntry[] = [];
    const cleaned = stripBom(text);
    const normalized =
        cleaned.includes("\\n") && !cleaned.includes("\n")
            ? cleaned.replace(/\\n/g, "\n")
            : cleaned;
    for (const rawLine of normalized.split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (!line) continue;
        const isHttpOnly = line.startsWith("#HttpOnly_");
        if (line.startsWith("#") && !isHttpOnly) continue;
        const effectiveLine = isHttpOnly ? line.slice("#HttpOnly_".length) : line;
        const cols = effectiveLine.split("\t");
        if (cols.length < 7) continue;
        const domain = (cols[0] ?? ".youtube.com").trim();
        const name = cols[5] ?? "";
        if (!domain || !name) continue;
        entries.push({
            domain,
            includeSubdomains: (cols[1] ?? "TRUE").toUpperCase() === "TRUE",
            path: cols[2] ?? "/",
            secure: (cols[3] ?? "TRUE").toUpperCase() === "TRUE",
            expiration: Number.parseInt(cols[4] ?? "0", 10) || 0,
            name,
            value: cols.slice(6).join("\t"),
            ...(isHttpOnly ? { httpOnly: true } : {}),
        });
    }
    return entries;
}

function parseCookieEditorJson(text: string): NetscapeCookieEntry[] {
    const trimmed = stripBom(text).trim();
    if (!trimmed.startsWith("[")) {
        return [];
    }
    try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!Array.isArray(parsed)) return [];
        const entries: NetscapeCookieEntry[] = [];
        for (const item of parsed) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            const domain = typeof rec.domain === "string" ? rec.domain.trim() : "";
            const name = typeof rec.name === "string" ? rec.name : "";
            const value = typeof rec.value === "string" ? rec.value : "";
            if (!domain || !name) continue;
            const expRaw =
                typeof rec.expirationDate === "number"
                    ? rec.expirationDate
                    : typeof rec.expires === "number"
                      ? rec.expires
                      : 0;
            entries.push({
                domain,
                includeSubdomains: domain.startsWith("."),
                path: typeof rec.path === "string" && rec.path ? rec.path : "/",
                secure: rec.secure === true,
                expiration: Number.isFinite(expRaw) && expRaw > 0 ? Math.floor(expRaw) : 0,
                name,
                value,
                ...(rec.httpOnly === true ? { httpOnly: true } : {}),
            });
        }
        return entries;
    } catch {
        return [];
    }
}

/**
 * Parses YouTube cookies from Netscape cookies.txt (including #HttpOnly_ lines,
 * single-line \n-escaped env vars), Cookie-Editor JSON exports, or base64 blobs.
 */
export function parseNetscapeCookieEntries(rawInput: string): NetscapeCookieEntry[] {
    const cleaned = stripBom(rawInput);
    const jsonDirect = parseCookieEditorJson(cleaned);
    if (jsonDirect.length > 0) {
        return jsonDirect;
    }

    const netscapeDirect = parseNetscapeLines(cleaned);
    if (netscapeDirect.length > 0) {
        return netscapeDirect;
    }

    const compact = cleaned.trim().replace(/\s+/gu, "");
    if (compact.length >= 16 && /^[A-Za-z0-9+/=]+$/u.test(compact)) {
        try {
            const decoded = stripBom(Buffer.from(compact, "base64").toString("utf8"));
            const jsonDecoded = parseCookieEditorJson(decoded);
            if (jsonDecoded.length > 0) {
                return jsonDecoded;
            }
            return parseNetscapeLines(decoded);
        } catch {
            return [];
        }
    }
    return [];
}
